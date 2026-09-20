# Decide benchmark — 30 states

All calls are sequential, so the latency below is per call and never a concurrency artefact.
Per state: Jev 3 calls, Haiku 5, Sonnet 5.

## Cost and latency

| engine | states | median ms | p95 ms | input tok | output tok | invalid | cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jev | 30 | 602 | 641 | 203334 | 0 | 0 | $0.0085 |
| haiku | 30 | 1092 | 1569 | 277285 | 3986 | 0 | $0.2972 |
| sonnet | 30 | 1683 | 2483 | 313910 | 4295 | 0 | $0.6708 |

## Repeat stability

Mean pairwise L1 between the independent distributions measured for the same state. Lower is steadier. Jev is always repeated three times, which gives three pairs; the LLMs are repeated only under `--repeat`, which gives one.

| engine | mean repeat L1 |
| --- | --- |
| jev | 0.060 |
| haiku | n/a |
| sonnet | n/a |

## Agreement with the Sonnet reference

There is no ground truth here. The reference is Sonnet's sample mode — the most frequent of its five samples — which is stochastic: it is a reference point, not a correct answer, and another run may pick differently.

| engine | argmax agreement | mean L1 vs Sonnet | hand-label accuracy |
| --- | --- | --- | --- |
| jev | 83% | 0.602 | n/a |
| haiku | 77% | 0.400 | n/a |
| sonnet | 100% | 0.000 | n/a |

## Pairwise distance

Every pair of engines that ran, so the two cheap engines are compared to each other and not only to Sonnet.

| pair | mean L1 | argmax agreement |
| --- | --- | --- |
| jev vs haiku | 0.464 | 87% |
| jev vs sonnet | 0.602 | 83% |
| haiku vs sonnet | 0.400 | 77% |

## Per state

| state | reference | jev | haiku | sonnet | L1 jev | L1 haiku | L1 sonnet |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-20T17-50-02-63zn#1 | el_04 | el_04 | el_04 | el_04 | 0.101 | 0.000 | 0.000 |
| 2026-09-20T17-50-02-63zn#3 | el_05 | el_05 | el_05 | el_05 | 0.020 | 0.000 | 0.000 |
| 2026-09-20T17-50-02-63zn#5 | el_05 | el_05 | el_05 | el_05 | 0.000 | 0.000 | 0.000 |
| 2026-09-20T17-50-02-63zn#7 | el_05 | el_05 | el_05 | el_05 | 0.020 | 0.000 | 0.000 |
| 2026-09-20T17-50-02-63zn#10 | el_09 | el_09 | el_09 | el_09 | 0.180 | 0.000 | 0.000 |
| 2026-09-20T17-50-02-63zn#12 | el_09 | el_09 | el_09 | el_09 | 0.160 | 0.000 | 0.000 |
| 2026-09-20T17-50-42-1csa#2 | el_04 | el_04 | el_03 | el_04 | 1.360 | 1.200 | 0.000 |
| 2026-09-20T17-50-42-1csa#5 | el_09 | el_09 | el_09 | el_09 | 1.160 | 0.000 | 0.000 |
| 2026-09-20T17-50-42-1csa#7 | leave | el_05 | leave | leave | 1.560 | 0.000 | 0.000 |
| 2026-09-20T17-51-07-aodk#2 | el_03 | el_03 | el_03 | el_03 | 0.420 | 0.000 | 0.000 |
| 2026-09-20T17-51-07-aodk#5 | el_05 | el_05 | el_05 | el_05 | 0.000 | 0.000 | 0.000 |
| 2026-09-20T17-51-07-aodk#7 | el_05 | el_05 | el_05 | el_05 | 0.020 | 0.000 | 0.000 |
| 2026-09-20T17-51-07-aodk#9 | el_05 | el_05 | el_05 | el_05 | 0.400 | 0.000 | 0.000 |
| 2026-09-20T17-51-07-aodk#11 | el_05 | el_05 | el_05 | el_05 | 0.200 | 0.000 | 0.000 |
| 2026-09-20T17-51-20-y3xp#2 | el_03 | el_03 | el_03 | el_03 | 0.480 | 0.000 | 0.000 |
| 2026-09-20T17-51-20-y3xp#4 | el_09 | el_09 | el_09 | el_09 | 0.180 | 0.000 | 0.000 |
| 2026-09-20T17-51-20-y3xp#6 | el_09 | el_09 | el_05 | el_09 | 0.060 | 1.200 | 0.000 |
| 2026-09-20T17-51-20-y3xp#9 | el_05 | el_05 | el_05 | el_05 | 0.420 | 0.000 | 0.000 |
| 2026-09-20T17-51-20-y3xp#11 | el_05 | el_05 | el_05 | el_05 | 0.180 | 0.000 | 0.000 |
| 2026-09-20T17-51-33-r27o#1 | el_04 | el_04 | el_04 | el_04 | 0.560 | 0.400 | 0.000 |
| 2026-09-20T17-51-33-r27o#4 | el_05 | el_09 | el_09 | el_05 | 1.840 | 2.000 | 0.000 |
| 2026-09-20T17-51-33-r27o#6 | el_05 | el_09 | el_09 | el_05 | 1.980 | 2.000 | 0.000 |
| 2026-09-20T17-51-33-r27o#8 | el_09 | el_09 | el_09 | el_09 | 0.160 | 0.000 | 0.000 |
| 2026-09-20T17-51-33-r27o#10 | el_06 | el_09 | el_09 | el_06 | 1.560 | 1.600 | 0.000 |
| 2026-09-20T17-51-45-6are#2 | el_04 | el_04 | el_03 | el_04 | 1.320 | 1.200 | 0.000 |
| 2026-09-20T17-51-45-6are#4 | el_09 | el_09 | el_09 | el_09 | 0.626 | 0.000 | 0.000 |
| 2026-09-20T17-51-45-6are#6 | el_09 | el_09 | el_09 | el_09 | 0.160 | 0.000 | 0.000 |
| 2026-09-20T17-51-45-6are#9 | el_06 | el_05 | el_05 | el_06 | 1.180 | 2.000 | 0.000 |
| 2026-09-20T17-51-45-6are#11 | el_05 | el_05 | el_05 | el_05 | 0.760 | 0.400 | 0.000 |
| 2026-09-20T17-52-06-g86c#1 | switch_language:ru | switch_language:ru | switch_language:ru | switch_language:ru | 1.000 | 0.000 | 0.000 |
