// TUI-only JSX. Loaded dynamically from index.js so the server runtime
// (which parses index.js as plain JS and never transpiles JSX) never sees it.
export function liveRender(live: { text: string }) {
  return <text>🎙 {live.text}</text>
}
