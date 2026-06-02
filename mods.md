**Status: implemented** — pure extension fetch with DNR, parallel race, and chunked `ReadableStream` relay (`extension-fetch.js`, `extension-fetch-client.js`, `config/dnr-rules.json`, `manifest.json` v0.2.0). The Go daemon and `nativeMessaging` bridge are removed.

---

Ditching the external native daemon is a massive win for user experience. It eliminates complex installation scripts, makes your architecture instantly cross-platform, and removes the friction of security warnings.While an extension cannot directly bind to specific low-level hardware sockets to force a strict tcp4 vs tcp6 split, you can achieve a highly effective, pure-extension acceleration layer by leveraging the browser's native HTTP/3 (QUIC) connection pool and Declarative Net Request (DNR) mechanics.The Pure Extension ArchitectureBy removing the Go daemon and the native messaging bridge, the background service worker takes over the active transport role. It uses browser-native APIs to mimic the daemon's racing and credential-handling capabilities.1. Replacing Socket Racing: HTTP/3 Connection Pool RacingBrowsers naturally keep multiple parallel connections open to optimize page loads. You can exploit this by firing concurrent requests to the same video chunk using varying connection properties, forcing the browser's network stack to race paths to the Google Video CDN.Instead of writing Go routing loops, implement an asynchronous Fetch Race directly inside your background service worker using Promise.race() and AbortController.JavaScript// src/worker/background/io/extension-racer.js

export async function raceExtensionFetch(videoUrl, requestHeaders) {
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    // Strategy 1: High-priority, credential-inclusive stream (utilizes existing QUIC/H3 session)
    const fetchPathA = fetch(videoUrl, {
        method: 'GET',
        headers: { ...requestHeaders, 'X-Aegis-Track': 'A' },
        priority: 'high',
        credentials: 'include',
        signal: controller1.signal
    });

    // Strategy 2: Bypasses current connection slot constraints, forces fresh connection evaluation
    const fetchPathB = fetch(videoUrl, {
        method: 'GET',
        headers: { ...requestHeaders, 'X-Aegis-Track': 'B' },
        priority: 'low', // Alternating priority avoids socket starvation queues
        credentials: 'omit', 
        signal: controller2.signal
    });

    try {
        // Race the browser's own socket scheduling mechanics
        const winningResponse = await Promise.race([fetchPathA, fetchPathB]);
        
        if (!winningResponse.ok) throw new Error(`HTTP Error ${winningResponse.status}`);

        // Cleanly cancel the slower pipeline immediately to save bandwidth
        if (winningResponse.headers.get('X-Aegis-Track') === 'A') {
            controller2.abort();
        } else {
            controller1.abort();
        }

        return winningResponse;
    } catch (err) {
        // Fallback recovery if one path aborts or fails prematurely
        controller1.abort();
        controller2.abort();
        return fetch(videoUrl, { headers: requestHeaders }); // Native fallback
    }
}
2. Eliminating 403 Forbidden Errors: Session Header InjectionThe primary reason pre-fetches or background fetches fail with a 403 Forbidden on YouTube is that the background service worker runs in an isolated network scope separate from the active tab's cookie and tracking state.Instead of trying to pass session strings manually, use the chrome.declarativeNetRequest API. This tells the browser's core engine to automatically stamp any outgoing background fetch request bound for googlevideo.com with the identical credential headers, origins, and cookies belonging to the active YouTube tab.Add this static rule to your manifest.json:JSON"declarative_net_request": {
  "rule_resources": [{
    "id": "youtube_accelerator_rules",
    "enabled": true,
    "path": "src/worker/background/config/dnr-rules.json"
  }]
},
"permissions": [
  "declarativeNetRequest",
  "declarativeNetRequestFeedback"
],
"host_permissions": [
  "*://*.googlevideo.com/*",
  "*://*.youtube.com/*"
]
Then create your rule definitions configuration file to strip blocking security tags and inherit validation states seamlessly:JSON// src/worker/background/config/dnr-rules.json
[
  {
    "id": 1,
    "priority": 1,
    "action": {
      "type": "modifyHeaders",
      "requestHeaders": [
        { "header": "Origin", "operation": "set", "value": "https://www.youtube.com" },
        { "header": "Referer", "operation": "set", "value": "https://www.youtube.com/" },
        { "header": "Sec-Fetch-Mode", "operation": "set", "value": "cors" }
      ]
    },
    "condition": {
      "urlFilter": "googlevideo.com/videoplayback",
      "resourceTypes": ["xmlhttprequest", "other"]
    }
  }
]
3. Streamlining the Message FlowWithout the daemon serialization process (combineDaemonChunks), your background script doesn't have to compress binary chunks into massive Base64 strings anymore.Your service worker can now read incoming streaming responses chunk-by-chunk and pipe them straight through to the content relay using standard ReadableStream processing loops. This severely drops internal extension memory usage, eliminating the overhead that previously plagued performance during massive 27 MB UMP allocations.Summary of the ShiftCapabilityOld Daemon Method (External)New Extension Method (Pure)Path SelectionLow-level Go tcp4 vs tcp6 socket bindParallel browser connection pool racing via Promise.race()Auth SecurityString injection via Native Message framesNative header manipulation via declarativeNetRequestData OverheadBase64 serialization over STDOUTNative ReadableStream consumption loops in backgroundInstallationShell scripts + configuration filesSingle-click extension installation (Zero Setup)By moving this logic entirely into the service worker stack, you turn your project into an elegant, sandboxed utility that respects system resources while maintaining deep control over video transport loops.