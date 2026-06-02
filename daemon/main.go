package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type RequestMessage struct {
	ID      string            `json:"id"`
	Type    string            `json:"type"`
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"` // base64
}

type ResponseMessage struct {
	ID         string            `json:"id"`
	Type       string            `json:"type"` // "start", "chunk", "end", "error", "pong"
	StatusCode int               `json:"statusCode,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Data       string            `json:"data,omitempty"` // base64
	Error      string            `json:"error,omitempty"`
}

var (
	stdoutMutex sync.Mutex
)

// Read Native Messaging protocol from stdin
func readMessage() ([]byte, error) {
	var length uint32
	err := binary.Read(os.Stdin, binary.LittleEndian, &length)
	if err != nil {
		return nil, err
	}
	if length > 1024*1024*10 { // sanity check 10MB
		return nil, io.ErrShortBuffer
	}
	msg := make([]byte, length)
	_, err = io.ReadFull(os.Stdin, msg)
	if err != nil {
		return nil, err
	}
	return msg, nil
}

// Write Native Messaging protocol to stdout
func writeMessage(msg interface{}) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	stdoutMutex.Lock()
	defer stdoutMutex.Unlock()

	err = binary.Write(os.Stdout, binary.LittleEndian, uint32(len(b)))
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(b)
	return err
}

// Racing Logic
func raceRequest(reqMsg RequestMessage) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // will cancel the slower request when this function exits

	type raceResult struct {
		resp *http.Response
		err  error
		net  string
	}

	// Buffered to 2 to prevent goroutine leak
	resultChan := make(chan raceResult, 2)

	doRequest := func(network string) {
		dialer := &net.Dialer{DualStack: false, Timeout: 10 * time.Second}
		transport := &http.Transport{
			DialContext: func(ctx context.Context, n, addr string) (net.Conn, error) {
				return dialer.DialContext(ctx, network, addr)
			},
			ForceAttemptHTTP2: true,
			MaxIdleConns:      100,
			IdleConnTimeout:   90 * time.Second,
		}
		client := &http.Client{Transport: transport, Timeout: 60 * time.Second}

		var bodyReader io.Reader
		if reqMsg.Body != "" {
			decoded, _ := base64.StdEncoding.DecodeString(reqMsg.Body)
			bodyReader = bytes.NewReader(decoded)
		}

		req, err := http.NewRequestWithContext(ctx, reqMsg.Method, reqMsg.URL, bodyReader)
		if err == nil {
			for k, v := range reqMsg.Headers {
				// We don't want the Go http client to mess with our explicit pseudo-headers or host if we can help it
				if strings.ToLower(k) == "host" {
					req.Host = v
				} else {
					req.Header.Set(k, v)
				}
			}
			resp, err := client.Do(req)
			resultChan <- raceResult{resp, err, network}
		} else {
			resultChan <- raceResult{nil, err, network}
		}
	}

	go doRequest("tcp4")
	go doRequest("tcp6")

	var winningResp *http.Response
	var finalErr error

	res1 := <-resultChan
	if res1.err == nil && (res1.resp.StatusCode >= 200 && res1.resp.StatusCode < 300) {
		winningResp = res1.resp
		log.Printf("[%s] Winner: %s (Status: %d)\n", reqMsg.ID, res1.net, res1.resp.StatusCode)
	} else {
		if res1.resp != nil {
			res1.resp.Body.Close()
		}
		log.Printf("[%s] %s failed or non-2xx: %v\n", reqMsg.ID, res1.net, res1.err)
		
		// wait for second runner
		res2 := <-resultChan
		if res2.err == nil && (res2.resp.StatusCode >= 200 && res2.resp.StatusCode < 300) {
			winningResp = res2.resp
			log.Printf("[%s] Winner (Fallback): %s (Status: %d)\n", reqMsg.ID, res2.net, res2.resp.StatusCode)
		} else {
			if res2.resp != nil {
				res2.resp.Body.Close()
			}
			log.Printf("[%s] %s failed or non-2xx: %v\n", reqMsg.ID, res2.net, res2.err)
			finalErr = res2.err
			if finalErr == nil {
				finalErr = io.EOF // generic error if both returned non-2xx
			}
		}
	}

	if winningResp == nil {
		errStr := "Both IPv4 and IPv6 paths failed"
		if finalErr != nil {
			errStr = finalErr.Error()
		}
		writeMessage(ResponseMessage{
			ID:    reqMsg.ID,
			Type:  "error",
			Error: errStr,
		})
		return
	}

	defer winningResp.Body.Close()

	respHeaders := make(map[string]string)
	for k, v := range winningResp.Header {
		if len(v) > 0 {
			respHeaders[k] = v[0]
		}
	}

	writeMessage(ResponseMessage{
		ID:         reqMsg.ID,
		Type:       "start",
		StatusCode: winningResp.StatusCode,
		Headers:    respHeaders,
	})

	buf := make([]byte, 512*1024) // 500KB chunks max
	for {
		n, err := winningResp.Body.Read(buf)
		if n > 0 {
			writeMessage(ResponseMessage{
				ID:   reqMsg.ID,
				Type: "chunk",
				Data: base64.StdEncoding.EncodeToString(buf[:n]),
			})
		}
		if err != nil {
			if err != io.EOF {
				log.Printf("[%s] Stream read error: %v\n", reqMsg.ID, err)
				writeMessage(ResponseMessage{
					ID:    reqMsg.ID,
					Type:  "error",
					Error: err.Error(),
				})
			}
			break
		}
	}

	writeMessage(ResponseMessage{
		ID:   reqMsg.ID,
		Type: "end",
	})
	log.Printf("[%s] Completed streaming\n", reqMsg.ID)
}

func main() {
	f, _ := os.OpenFile("/tmp/aegisstream-daemon.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if f != nil {
		log.SetOutput(f)
		defer f.Close()
	}
	log.Println("Daemon started")

	for {
		msg, err := readMessage()
		if err != nil {
			if err == io.EOF {
				log.Println("Stdin closed, exiting")
				break
			}
			log.Printf("Error reading message: %v\n", err)
			break
		}

		var req RequestMessage
		if err := json.Unmarshal(msg, &req); err != nil {
			log.Printf("Error parsing JSON: %v\n", err)
			continue
		}

		if req.Type == "fetch" {
			go raceRequest(req)
		} else if req.Type == "ping" {
			writeMessage(ResponseMessage{
				ID:   req.ID,
				Type: "pong",
			})
		} else {
			log.Printf("Unknown request type: %s\n", req.Type)
		}
	}
}
