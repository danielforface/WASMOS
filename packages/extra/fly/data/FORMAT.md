# FLYBRAIN/1 binary and numerical contract

All values little-endian. Header size 128 bytes. File is data only, never executable code. IDs remain uint64, strictly increasing, positive and unique. No rounding through JavaScript Number. Input IDs determine neuron count; there is no padding to 140,000.

| Byte | Type | Field |
|---:|---|---|
| 0 | 8 bytes | ASCII FLYBRAIN |
| 8 | u32 | Version 1 |
| 12 | u32 | Endian marker 0x01020304 |
| 16 | u32 | N neurons, 1..250000 |
| 20 | u32 | E edges, 0..32000000 |
| 24 | u32 | M mapping records, 0..1000000 |
| 28 | u32 | 0 synthetic; 1 external; 2 reserved external variant. Not authentication. |
| 32 | u32 | Exact total bytes, <=440MiB |
| 36 | u32 | IEEE CRC32 of bytes 128..end, corruption detection only |
| 40 | u32 | IDs offset = 128 |
| 44 | u32 | Rows offset = IDs offset + N*8 |
| 48 | u32 | Targets offset = rows offset + (N+1)*4 |
| 52 | u32 | Weights offset = targets offset + E*4 |
| 56 | u32 | Delays offset = weights offset + E*4 |
| 60 | u32 | Maps offset = align4(delays offset + E) |
| 64 | f32 | Membrane tau, 2..1000 ms |
| 68 | f32 | Current tau, 1..1000 ms |
| 72 | f32 | Threshold, .01..100 |
| 76 | u32 | Refractory ticks, 0..50 |
| 80 | u32 | Provenance JSON byte count |
| 84 | u32 | Reserved zero |
| 88 | u32 | Metadata offset = maps offset + M*16 |
| 92 | f32 | Global synapse gain, (0,4]; zero means legacy default 1 |
| 96 | f32 | Input gain, (0,8]; zero means 1 |
| 100 | f32 | Acoustic gain, (0,8]; zero means 1 |
| 104..127 | bytes | Reserved zero |

Arrays: IDs u64[N], rows u32[N+1], targets u32[E], weights f32[E], delays u8[E], alignment padding, mappings, UTF-8 metadata. Rows are monotonic from 0 to E. Targets are zero-based indices. Weights must be finite in [-100,100]; delays 1..15 ms. Parallel source-neuropil rows remain parallel edges. An edge is not necessarily one synapse.

Mapping record `<IHBBff` (16 bytes): neuron index u32, input channel u16, output action u8, reserved u8, input gain f32, output gain f32. Gains must be finite in [-100,100]. Multiple records for one neuron are permitted.

| Input | Signal |
|---:|---|
| 0 | No input |
| 1..24 / 25..48 | Left/right 8 angles × 3 distances |
| 49..56 | WAV frequency bands 80×1.65^k Hz, k=0..7 |
| 57 / 58 | Boundary contact left/right |
| 59 | 1 − virtual energy |
| 60 | Virtual altitude |
| 61 | Virtual speed / 180 |
| 62 | Virtual energy |
| 63 | Seeded uniform random sample |
| 64 | Constant 1 |

| Output | Action |
|---:|---|
| 0 | None |
| 1 | Forward drive |
| 2 / 3 | Left/right turn |
| 4 | Flight drive |
| 5 | Grooming drive; reduces speed, no full grooming biomechanics |
| 6 | Feeding drive; virtual energy recovery, no food recognition |

## Integration and body

Fixed dt = 1 ms. At tick t: `I = exp(-1/tauS)*I + impulses[t mod 16]`; clear consumed impulses. During refractory keep V=0 and decrement remaining ticks. Otherwise `V = exp(-1/tauM)*V + (I + mapped_input)*(1-exp(-1/tauM))`. Emit spike if V>=threshold, reset V=0 and start refractory. Otherwise clamp below at -20*threshold. A spike at t schedules each outgoing weight × global synapse gain at t+delay. Current input sums mapping signal × mapping gain × global input gain. There is no hidden body drive.

Rate traces multiply by exp(-.01) each tick and add 10Hz on a spike (100ms exponential filter). Every 10ms, each action is its mapped rate population mean × mapping gain / 80Hz, clamped [0,1]. Forward target speed is action1*145*(1-.7*action5), approached by an .08 relaxation per body step. Turn rate is 4.2*(action3-action2). Motion is constrained to the 2D arena. Altitude and energy are simple illustrative state variables, not aerodynamics or physiology.

The neuron sweep and edge scatter are resumable. All outgoing edges are processed before completing a tick. The renderer gives simulation about 6ms per frame. The fixed neural dt never expands to fake real time; lag is reported. Catch-up debt is capped at 250ms. Direct `flyStep` verification runs without this UI time budget.

Visual input is ground-plane luminance sampled relative to body heading, plus a finite-difference transient; it is not a calibrated compound eye. WAV uses 20ms Hann-windowed Goertzel bands and RMS, with a simulation-time cursor. Speaker preview uses independent wall time. See README_HE.md for scientific limits.
