// A fire-and-forget queue that runs async tasks strictly one-at-a-time, in order.
// Used to serialize git operations on a repo — git can't run concurrent commands
// on one working tree safely (index.lock races), and we never block the event
// loop waiting on them. Pure — unit-tested.
export function createSerialQueue(): (task: () => Promise<unknown>) => void {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    tail = tail.then(() => task()).catch(() => {}); // run in order; swallow errors so the chain never stalls
  };
}
