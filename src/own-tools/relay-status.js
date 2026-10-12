// relay_status — which browser profile this session is driving, and who holds
// the base (spec v4 §1c). needsBrave: false — asking must never launch a
// 0.6–1.2 GB Brave or claim anything (RelayServer skips ensureBrave() for it).
// The payload comes from index.js via globalThis.__relayStatus.

module.exports = {
  name: "relay_status",
  needsBrave: false,
  description:
    "Browser profile status for this session: BASE (this project's saved logins) or CLONE (a copy whose logins are " +
    "deleted at session end), who holds the base and since when, this session's Brave and CDP port, and the other " +
    "clones in this project. Call it before any sign-in. Never launches a browser.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const get = globalThis.__relayStatus;
    if (typeof get !== "function") {
      return { content: [{ type: "text", text: "relay_status unavailable (relay not initialised)" }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(await get(), null, 2) }] };
  },
};
