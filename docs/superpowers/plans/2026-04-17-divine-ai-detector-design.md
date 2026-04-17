# divine-ai-detector — design

**Status:** design, not implementation. Bootstraps from logo detection (PR #97)
but shaped so Hive and Reality Defender calls can be phased down as internal
signals come online. No cutover in this design — design for the cutover.

## Mission

Run Divine's AI-content detection internally for the signals where internal
inference is cheap and high-confidence; keep Hive and Reality Defender for the
ambiguous long tail. Distill vendor verdicts into internal models over time so
the long tail shrinks.

Not: "rip out Hive/RD." That's the result if distillation works.

## Scope

**v0 (this quarter):** one signal, `watermark_visible`.
Classifier: ONNX CNN on four 15% corner crops per frame → per-generator class.
Classes are the ones already in `src/moderation/logo_detector.mjs`:
`meta_sparkle`, `openai_sora`, `google_veo`, `runway`, `kling`, `pika`, `luma`,
`other_logo`, `clean`.

**v0.5 (when Meta publishes Video Seal prefix):** add `watermark_invisible`.
Spec-defined decoder, no ML.

**v1 (next quarter):** distilled `ai_generated` signal trained from N weeks of
Hive verdicts.

**v1.5:** `deepfake_face_swap` from public datasets (FaceForensics++, DFDC)
fine-tuned on Divine traffic.

**Out of scope, forever:** NSFW / violence / hate / self-harm. Those stay with
Hive — different domain, different ethics, different liability.

## API

Service name: `divine-ai-detector`. Deployed next to `divine-inquisitor` on
GKE, same ArgoCD umbrella, same secrets pattern.

### `POST /detect`

One endpoint, signal-oriented. Caller picks which signals to run; service
returns one envelope per signal. Missing signal = not requested, not an error.

```json
Request:
{
  "url": "https://media.divine.video/<sha256>.mp4",
  "mime_type": "video/mp4",
  "sha256": "<sha256>",            // optional, used as cache key
  "signals": ["watermark_visible"] // default: all enabled signals
}

Response:
{
  "sha256": "<sha256>",
  "checked_at": "2026-04-17T...Z",
  "duration_ms": 430,
  "signals": {
    "watermark_visible": {
      "state": "detected",         // detected | absent | error | skipped
      "class": "meta_sparkle",     // signal-specific payload below state
      "confidence": 0.92,
      "frames_flagged": 3,
      "total_frames": 4,
      "model": "logo-v1.2.0"
    }
  }
}
```

**Why one envelope per signal, not one top-level verdict:** each signal has a
different model, different confidence distribution, different update cadence.
The moderation worker decides how to combine them into policy — we don't
pretend we know the right fusion yet.

**Why `state` before the payload:** uniform tri-state lets the moderation
worker branch without knowing each signal's payload shape. `error` and
`skipped` are first-class states — vendor-fallback logic needs to distinguish
"no watermark found" from "we didn't run this" from "the model crashed."

### `GET /healthz` / `GET /livez` / `GET /readyz` / `GET /metrics`

Standard inquisitor shape. `readyz` only returns 200 after all active models
have loaded, so K8s doesn't route traffic during warmup.

## Signal taxonomy + vendor parity

The moderation pipeline's existing AI-content logic keys on `ai_generated` and
`deepfake` category scores (see `wrangler.toml` `AI_GENERATED_THRESHOLD_*`).
Keep that contract — don't invent a parallel taxonomy.

| Internal signal        | Policy category it feeds | Vendor parity           |
|------------------------|--------------------------|-------------------------|
| `watermark_visible`    | `ai_generated`           | Hive `ai_generated` score (strong, corner-specific) |
| `watermark_invisible`  | `ai_generated`           | No vendor equivalent — ground truth when present |
| `ai_generated`         | `ai_generated`           | Hive `ai_generated`, Reality Defender                 |
| `deepfake_face_swap`   | `deepfake`               | Hive `deepfake`, Reality Defender                     |

The pipeline receives per-signal results, converts them to a normalized
`ai_generated` / `deepfake` score using per-signal weights, and then runs the
existing threshold logic unchanged. This is the contract that lets us swap
internal for vendor without changing the policy layer.

## Cutover strategy — four modes, per signal

Every signal moves through these modes independently. The mode is a config
knob on the moderation worker, not on `divine-ai-detector`.

1. **shadow** — moderation worker calls both vendor and internal, uses vendor
   verdict, logs both + disagreement. No user impact. Goal: calibrate
   thresholds, measure agreement rate.
2. **gated** — internal verdict used only when `confidence >= GATE`. Below
   gate, fall through to vendor. GATE tuned from shadow-mode data.
3. **preferred** — internal verdict always used when `state != error`. Vendor
   called only on `error` / `skipped`.
4. **sole** — internal only. Vendor call removed. Only move a signal here
   after sustained preferred-mode agreement > 95% vs. vendor and zero
   regressions in human review.

Each signal's current mode is a single env var on the worker:
`AI_DETECTOR_MODE_WATERMARK_VISIBLE=shadow|gated|preferred|sole`.
Default for every new signal is `shadow`. Cutover = flip a var, not a deploy.

**Rollback:** flip the var back. No data migration, no schema change. Vendor
code stays wired the whole time.

## Training data capture

The distillation play only works if we log everything now:

- Every Hive + RD verdict already gets logged in D1 `moderation_results`. Good.
- Add: every `divine-ai-detector` verdict logged in the same table, keyed by
  `sha256` + `signal` + `model_version`.
- Add: when a human moderator overrides an automated verdict, flag the
  `sha256` + the override reason. This is the highest-signal training data we
  have and it's essentially free.
- Training pipeline (out of scope for v0, but keep the data shape clean
  enough to feed it): export D1 slice → GCS → training job on Vertex AI or a
  GCE spot node → upload new ONNX to GCS → bump `LOGO_DETECTOR_MODEL_URL` →
  canary in shadow mode → roll to preferred.

## Non-negotiable contracts

These must not drift, or cutover becomes a migration instead of a config flip:

1. **Signal names** are stable forever once published. Rename = new signal +
   deprecation window on the old one.
2. **`state` values** are stable: `detected | absent | error | skipped`. No
   new values without a major version bump.
3. **`confidence` is 0.0–1.0**, calibrated so 0.7 is the Hive-equivalent
   moderate threshold and 0.8 is the Hive-equivalent high threshold. Models
   that don't output calibrated probabilities get Platt-scaled at training
   time, not at inference time.
4. **`model` field is required** on every signal response so we can bisect
   regressions by model version.
5. **`duration_ms` is required** so the worker can enforce a timeout budget
   and fall through to vendors under load.

## Service architecture

- **Runtime:** Rust + Axum, distroless, same shape as `divine-inquisitor`. ONNX
  inference via `ort` crate (Rust bindings for ONNX Runtime). CPU-only to
  start; add GPU node pool if/when a signal needs it.
- **Models:** each signal has one active model. Models downloaded from GCS at
  startup, pinned by SHA. Version + SHA logged to Prometheus.
- **Frame extraction:** the service fetches the video (or accepts
  pre-extracted frames — see open question), decodes N keyframes via
  `ffmpeg` (present in the image, not in the binary), hands frames to each
  signal's inference path. Frame count per call is a config knob per signal.
- **Caching:** result cached in-memory by `sha256 + signal + model_version`
  for `CACHE_TTL`. Not authoritative — the authoritative cache is D1 on the
  moderation worker side. In-memory cache is for avoiding redundant
  reinvocation within a burst.
- **Resource footprint (starting point):** 2 replicas, 512Mi–2Gi memory, 500m–2
  CPU, HPA on CPU. Tune after shadow-mode traffic.

## Minimum file set — new repo (`divine-ai-detector`)

```
Dockerfile                       (multi-stage; distroless final; ffmpeg baked in)
Cargo.toml                       (axum, ort, reqwest, serde, tracing, metrics)
src/main.rs                      (wire routes + graceful shutdown)
src/routes/detect.rs             (POST /detect — signal dispatch)
src/routes/health.rs             (healthz / livez / readyz / metrics)
src/signals/mod.rs               (Signal trait: fn detect(&self, frames) -> Envelope)
src/signals/watermark_visible.rs (v0 implementation; port logo_detector.mjs logic)
src/frames.rs                    (ffmpeg-cli frame extraction)
src/model_store.rs               (GCS download + SHA pinning)
tests/                           (integration tests against fixture videos)
.github/workflows/ci.yml         (test → docker push → dispatch to IaC repo)
README.md                        (API + runbook)
```

## Minimum file set — IaC PR (`divine-iac-coreconfig`)

```
k8s/applications/divine-ai-detector/base/
  deployment.yaml                (2 replicas, readiness probe, prometheus scrape)
  service.yaml
  httproute.yaml                 (ai-detector.ENVIRONMENT.divine.video)
  kustomization.yaml
k8s/applications/divine-ai-detector/overlays/{poc,staging,production}/
  kustomization.yaml             (image tag, replica count, hostname)
k8s/argocd/apps/divine-ai-detector.yaml   (ApplicationSet)
k8s/external-secrets/base/divine-ai-detector-secrets.yaml  (GCS SA, if needed)
```

## Worker-side changes (future PRs, not now)

- Rename `LOGO_DETECTOR_MODEL_URL` → `AI_DETECTOR_BASE_URL` (HTTP client to the
  new service, not a direct model URL).
- Reshape `src/moderation/logo_detector.mjs` into `ai-detector-client.mjs` —
  thin HTTP client over `POST /detect`, still returning per-signal verdicts.
- `src/moderation/logo_aggregator.mjs` keeps its vote math; it becomes the
  Worker-side fusion layer that combines multiple signals' `confidence` into a
  single `ai_generated` score. Lives next to the policy code, which is where
  threshold tuning belongs.
- `AI_DETECTOR_MODE_*` env vars per signal for shadow/gated/preferred/sole.

PR #97 can merge as-is (it's a self-contained stub with its own tests); the
above worker-side rewiring is the first follow-up PR once `divine-ai-detector`
is reachable in staging.

## Open questions

1. **Frame extraction — service or worker?** Simpler for the service to fetch
   + decode. But extracting frames in divine-moderation-service (Cloudflare
   Images? divine-cdn-worker?) keeps the AI detector stateless and lets the
   same frames feed multiple calls (logo + Video Seal + generic classifier).
   Lean: start with service-side extraction; factor out if we add ≥3 signals.
2. **Vertex AI vs self-hosted training?** Out of scope now; decide when the
   first distillation run is scheduled.
3. **Do we deprecate `divine-realness`?** No — it becomes the vendor-wrapper
   the moderation worker calls *as a fallback* after `divine-ai-detector`
   errors or returns low-confidence. Its scope narrows; it doesn't go away.
4. **Per-signal timeouts.** Each signal's time budget probably differs (logo
   is fast, generic AI classifier is slower). Decide on default: global
   budget, per-signal budget, or caller-provided.

## Not in this design

- Actually building any of the above. This is a design to align on before
  bootstrapping the repo.
- NSFW / violence / hate / self-harm internal inference. Those stay vendor.
- Pricing model for selling this service externally. Internal tool.
