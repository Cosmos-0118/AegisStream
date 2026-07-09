/**
 * Run: node test/page/core/site-policy.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const sitePolicyPath = path.join(__dirname, "../../../src/page/core/site-policy.js")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function loadPolicy({ href, hostname, pathname, isTop = true }) {
  const sandbox = {
    globalThis: {},
    location: { href, hostname, pathname },
    window: {}
  }
  sandbox.window.top = isTop ? sandbox.window : {}
  sandbox.self = sandbox.globalThis
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(sitePolicyPath, "utf8"), ctx)
  return sandbox.globalThis.AegisSitePolicy
}

const watchTop = loadPolicy({
  href: "https://reanime.to/watch/bang-dream-yume-mita-3sebzu",
  hostname: "reanime.to",
  pathname: "/watch/bang-dream-yume-mita-3sebzu",
  isTop: true
})
assert(watchTop.shouldRunMediaBridge() === true, "watch page should arm media bridge")
assert(watchTop.isLikelyPlaybackContext() === true, "watch path is playback context")

const browseTop = loadPolicy({
  href: "https://reanime.to/",
  hostname: "reanime.to",
  pathname: "/",
  isTop: true
})
assert(browseTop.shouldRunMediaBridge() === false, "site home should stay passive")

const playerFrame = loadPolicy({
  href: "https://megacloud.blog/embed-2/e-1/abc",
  hostname: "megacloud.blog",
  pathname: "/embed-2/e-1/abc",
  isTop: false
})
assert(playerFrame.shouldRunMediaBridge() === true, "player iframe should arm media bridge")
assert(playerFrame.isLikelyPlaybackContext() === true, "iframe is playback context")

const episodePath = loadPolicy({
  href: "https://animesuge.cz/anime/show/ep-1",
  hostname: "animesuge.cz",
  pathname: "/anime/show/ep-1",
  isTop: true
})
assert(episodePath.shouldRunMediaBridge() === true, "episode path should arm media bridge")

const twitch = loadPolicy({
  href: "https://www.twitch.tv/somechannel",
  hostname: "www.twitch.tv",
  pathname: "/somechannel",
  isTop: true
})
assert(twitch.isReactivePrefetchSite() === true, "twitch is reactive")
assert(twitch.shouldRunMediaBridge() === false, "twitch must never arm interceptors")

console.log("site-policy.test.js: all assertions passed")
