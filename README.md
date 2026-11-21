[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Kkajasd/sokoban-solver-20261121/rank.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Kkajasd/sokoban-solver-20261121/reward.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)

# sokoban-solver-20261121

A push-optimal Sokoban solver for make.fun's `sokoban-solver-01-run-20261121`
($100, 10 × $10). One run answers all 5 instances of a set in as few pushes as
possible.

## How it works

Levels are a hallway with independent rooms off it — a box pushed out of a room
can never come back — so each level is split into its rooms and every room is
solved on its own; the rooms' optima add up to the level's optimum P\*.

Each room is solved with A\* over pushes: a state is the boxes' squares plus the
player's reachable region (named by its lowest square). A push costs 1 and the
estimate is the cheapest assignment of boxes to goals under the lone-box push
distances, which never overestimates, so the first solved state popped is
push-optimal. Two deadlocks are pruned: a box on a dead square (no push from
there can ever reach a goal, found by pulling back from the goals) and a frozen
2×2 block of walls and boxes holding a box off its goal. A greedy best-first
search with the same heuristic is the fallback if the A\* budget runs out, and a
whole-level search covers levels that are no set of rooms.

Everything is budgeted by work counted (expanded states), never by the wall
clock, so two runs write the same bytes. No network, no clock reads, no
randomness.

## Results (practice set, kit scorer)

- Score **1,000,000** — all 5 instances solved in exactly P\* pushes
  (13, 16, 29, 47, 60), in ~0.3 s for the whole set.
- The house baseline (plain-astar 1.0.0) scores 200,000 on the same set: it
  solves only i001 and leaves i002–i005 unsolved.
- 8 further sets drawn from the published generator with fresh random seeds:
  all 5 instances at P\* every time, score 1,000,000 each, 0.2–0.4 s per set.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `/input/<id>/level.txt` (XSB) and writes
`/output/<id>/solution.txt` (moves in LURD, an upper letter marks a push).
