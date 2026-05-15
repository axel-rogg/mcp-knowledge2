// AS-3 K10/K11: MCP tool registration entry-point.
//
// K10 stubs this so the server boots with an empty tool-list.
// K11 fills in all REST-wrapped tools (objects, search, shares, uploads).

export function registerAllTools(): void {
  // K11 lands the actual registrations.
}
