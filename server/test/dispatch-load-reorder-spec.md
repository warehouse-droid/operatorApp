# Dispatch whole-load reorder positional metadata specification

## Scope

This change applies only to editable Dispatch Planning whole-load reordering.
It does not change immutable load IDs, assigned orders/stops, physical truck
assignments, Driver PWA job IDs, or completed/in-progress load protections.

## Executable scenarios

1. **Non-adjacent Load 3 to Load 1**
   - Given one driver lane with Load 1 at a dedicated 07:00 start from yard
     3445, Load 2 on automatic inheritance, and Load 3 at a dedicated 13:00
     start,
   - when the dispatcher drags Load 3 before Load 1,
   - then Load 3 becomes the displayed Load 1 and receives the 07:00/3445
     route-start context,
   - and the displaced loads receive the timing modes belonging to their new
     positions.

2. **Non-adjacent Load 1 to Load 3**
   - When the dispatcher drags Load 1 after Load 3,
   - then the new first load receives the route-start context and the former
     Load 1 does not retain it in its later position.

3. **Every three-load permutation**
   - Every one of the six permutations of three load IDs must produce canonical
     `driverSequence` values 0, 1, 2 and display names Load 1, Load 2, Load 3.
   - The positional start signature must remain dedicated 07:00, automatic,
     dedicated 13:00.

4. **Random repeated swaps**
   - Deterministic seeded sequences repeatedly move arbitrary pairs before and
     after one another, including Load 1/Load 3.
   - After every move, route-start ownership, naming, sequence, and content
     invariants must still hold.

5. **Saved plan evidence**
   - The real browser must submit the new first load with the route-start fields
     in the Dispatch command payload.
   - Reloading the acknowledged saved plan must keep the same ownership.

## Must-not-change invariants

- Load IDs and their order/stop content move together and are never recreated.
- Truck IDs/plates stay with their load.
- A later dedicated timing slot remains dedicated.
- Real truck-switch handoff yards continue to be calculated from the preceding
  load; route-start yard transfer must not overwrite a different-truck handoff.
- Loads with Driver activity remain non-draggable.
- Driver PWA code and storage are outside this change.

## Setup and tooling

- Use the repository's existing Node test runner, Playwright, ESLint, and Docker
  test images; add no dependency.
- Run all behavioral and browser checks in the isolated MBT test stack.
- Do not commit or deploy as part of this task.
