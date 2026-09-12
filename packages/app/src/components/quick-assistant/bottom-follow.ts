type Metrics = { scrollTop: number; scrollHeight: number; clientHeight: number }

export function createBottomFollow() {
  let following = true
  let previousTop = 0
  const maximum = (node: Metrics) => Math.max(0, node.scrollHeight - node.clientHeight)
  return {
    following: () => following,
    reset() {
      following = true
      previousTop = 0
    },
    pause() {
      following = false
    },
    written(node: Metrics) {
      previousTop = node.scrollTop
    },
    scrolled(node: Metrics) {
      const top = Math.max(0, node.scrollTop)
      const max = maximum(node)
      // Layout shrinkage can clamp scrollTop; only intentional upward movement detaches.
      if (top < Math.min(previousTop, max) - 1) following = false
      else if (max - top <= 8) following = true
      previousTop = top
      return following
    },
  }
}
