(() => {
var ns = (self.AegisPageBridge ||= {})
/** Legacy slot — unified seeking lives in src/page/playback/seeking-controller.js */
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("seek-predictor")) return
})()
