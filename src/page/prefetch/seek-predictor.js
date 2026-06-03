(() => {
var ns = (self.AegisPageBridge ||= {})
/** Legacy slot — unified seeking lives in src/page/media/seeking-controller.js */
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("seek-predictor")) return
})()
