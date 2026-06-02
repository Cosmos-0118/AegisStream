(() => {
var ns = (self.AegisBackground ||= {})

let chain = Promise.resolve()

function enqueueStoreWrite(task) {
  const run = chain.then(() => task())
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

ns.enqueueStoreWrite = enqueueStoreWrite
})()
