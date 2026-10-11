# Load-balanced routing demo

A time-slotted vehicle simulation on an OpenMapTiles road network. Vehicles choose routes, the load their trips put on the
roads slows those roads down in the next time slot, and the routes come out as series of coordinates with timestamps.
The routes are animated as moving dots on a map. The simulation runs in the browser, with no backend.

**Live:** https://graphmasters.github.io/load-balanced-routing-demo/ shows a precomputed sample of 300 routes. "Run"
builds the road network from map tiles in your browser and simulates on it.

## The model

- **Trips.** Random origins in a disc, random destinations in a disc or polygon, random departures in a window. Everything
  is seeded: the same seed gives the same trips. A radius of 0 is a single point, so one OD pair with random departures
  is a special case.
- **Slots.** Time runs in slots of 10 s. A vehicle plans its route when it departs, with the speeds of its departure slot.
- **Speeds follow entries.** The speed of a link in a slot is the BPR curve (Bureau of Public Roads) applied to the
  vehicles that entered the link in the *previous* slot, as vehicles per hour over the link's capacity. A vehicle that
  enters a link in slot *k* slows it from slot *k + 1* on. Defaults: alpha 0.15, beta 4, floor 2 km/h.
- **Route choice.** Each vehicle perceives each link's travel time with a factor in `[1 − noise, 1 + noise]`, drawn per
  vehicle and link. Vehicles then disagree about the cheapest path, which gives several routes for one OD pair. Noise 0
  gives one path.
- **Network.** Links are directed road pieces between consecutive OpenStreetMap vertices. Trips snap to the largest
  strongly connected part of the network, so no trip starts on an island.

## Sources of the link speed model

The core formula is the BPR curve from the US Bureau of Public Roads, and its default constants are α = 0.15 and β = 4. The constants are from memory and have not yet been checked against a primary source. The "previous slot's entries" rule, the floor, and the capacity table are the project's own choices. The code labels the capacities as illustrative, not calibrated.

## Use the engine

The engine is the code in `src/`. It works on any road network of the shape `createNetwork` describes, and
`networkFromOmtGraph` adapts the graph that [omt-router](https://github.com/AbelVM/omt-router)'s `buildGraphForTiles`
returns.

```ts
import { generateTrips, networkFromOmtGraph, positionAt, routesToGeoJSON, simulate } from './src/index'

// `graph` is what omt-router's buildGraphForTiles(tiles, 'car', { zoom: 14 }) returns.
const network = networkFromOmtGraph(graph)
const trips = generateTrips({
  count: 300,
  origin: { kind: 'circle', center: [9.74, 52.37], radiusM: 1500 },
  destination: { kind: 'circle', center: [9.785, 52.388], radiusM: 700 },
  departure: { fromS: 0, toS: 900 },
  seed: 7,
})
const result = simulate({ network, trips, seed: 7, routeNoise: 0.1 })

const [route] = result.routes
route.points // [[lng, lat, seconds], ...] ascending in time, from departure to arrival
positionAt(route, 300) // [lng, lat] at t = 300 s, or null before departure and after arrival
routesToGeoJSON(result.routes) // LineStrings with properties.times, one time per coordinate
```

`simulate` returns the routes of the trips that arrived, the number of unreachable trips, the share of the network the
trips could use (`coverage`), and per-slot statistics (`slots`, including `peakLinkEntries`, the vehicles that entered the
busiest link in a slot).

### Import it on another website

`npm run build:lib` writes `dist/lib/route-sim.js`: one ES module with no dependencies (about 5 KB gzipped), with type
declarations beside it. The GitHub Pages site publishes it, so a page can import it directly:

```html
<script type="module">
  import { simulate, positionAt } from 'https://graphmasters.github.io/load-balanced-routing-demo/lib/route-sim.js'
</script>
```

The engine does not contain omt-router. The graph has to come from somewhere, and the demo builds it with omt-router.

## Map data

- **Basemap and road network:** [OpenFreeMap](https://openfreemap.org)'s planet tileset, in the OpenMapTiles schema. It
  needs no key. The demo reads the tile URL from the tileset's TileJSON when it runs, because that URL carries a build
  version that changes over time.
- **Attribution:** OpenFreeMap and OpenMapTiles, and map data © OpenStreetMap contributors (ODbL). MapLibre shows it on the
  map.
- **Network size depends on the data build.** In the Hannover area, the OpenFreeMap build used here gives 34,684 nodes and
  67,526 links.

## Run

```bash
npm install
npm test            # engine tests (vitest)
npm run dev         # demo at http://localhost:5174
npm run build       # static site: dist/
npm run build:lib   # dist/lib/route-sim.js and its type declarations
```

Run `npm run build` before `npm run build:lib`: the site build empties `dist/`. GitHub Pages builds both on every push to
`main` (`.github/workflows/pages.yml`).

- **Live:** the scenario panel loads the basemap tiles, builds the road network in the browser and simulates. About 1 to
  1.5 s for 300 trips in Chromium on a laptop, and about 12 s for 1,500 trips.
- **Static:** `?routes=<url>` loads a routes file written by "Export GeoJSON" and animates it, with no computation.
  Without `?routes`, the page shows `sample-routes.geojson`.

## Limits

- **No queues.** A jammed link is passed at its floor speed, and vehicles keep entering it at their own pace. Flows into a
  jam are not capped at its capacity, so the busiest-link counts show demand, not queue length.
- **Links are OSM pieces** between vertices, so per-link counts are per piece. Aggregate to streets before reading
  congestion off them.
- **One-slot delay.** Speeds follow the previous slot, so a strong jam can overshoot and oscillate. Averaging the entries
  over more slots would damp it; this is not done.
- **Self-influence.** A vehicle's own entry counts toward the next slot's speed of its link. With realistic capacities this
  is a few per cent for one vehicle.
- **Route choice at departure.** A vehicle plans once, with the departure slot's speeds, and does not re-route in transit.
- **Parameters are illustrative.** The class capacities (`CAPACITY_VPH_BY_CLASS`) and the BPR parameters are not calibrated.
- **Speed.** Each trip runs one A* search over the snapped network, so the cost grows with trips and network size.

## Licence

Copyright © 2026 Graphmasters. Licensed under the GNU Affero General Public License v3.0 only (see [LICENSE](LICENSE)).

The demo imports [omt-router](https://github.com/AbelVM/omt-router), which is AGPL-3.0-only, to build the road graph. That
is why this repository is AGPL too. The engine in `src/` has no dependency on omt-router. The AGPL requires the source of
modified versions to be offered to users who interact with them over a network; this repository is that source.

## Provenance

The code in this repository was generated with Claude Haiku 5.5 (Claude Code).
