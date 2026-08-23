// pickNewActions and its cursor-diff tests were removed: the action feed no
// longer diffs against an in-memory cursor (see action-feed.ts's
// readUnpostedActions / markActionPosted — delivery state now lives in the
// row's posted_at column, durable across a restart). ActionLite itself is
// still live — discord-format.ts imports it for actionEmbed — so this module
// stays; there is nothing here to unit-test on its own beyond the type shape,
// which the discord-format.ts tests exercise through actionEmbed.
