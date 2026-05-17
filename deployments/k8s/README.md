# Kubernetes manifests — out of scope (pilot)

This directory was reserved for a future GKE Autopilot / generic
Kubernetes deploy target. **No manifests live here yet.**

Pilot targets are:

- **Fly.io** — primary. See [fly.toml](../../fly.toml) +
  [deploy/fly/](../../deploy/fly/).
- **Google Cloud Run** — secondary. See
  [deployments/cloud-run/](../cloud-run/) +
  [deploy/gcp/](../../deploy/gcp/).

If a k8s deploy is needed later, write manifests here for:

- `Deployment` (replicas=1, runtime image)
- `Service` (ClusterIP, port 8080)
- `Ingress` (your ingress controller of choice)
- `ConfigMap` (non-secret env from `fly.toml [env]`)
- `Secret` (synced from Doppler via Doppler's k8s operator or
  external-secrets.io targeting Secret Manager — same Doppler config as
  Cloud Run, `prd_gcp`)
- `Job` (`migrate-knowledge2` — same image, `npm run db:migrate`,
  runs as initContainer of the main Deployment or as a separate Job
  triggered pre-rollout)
- `HorizontalPodAutoscaler` (CPU + queue-depth)
- `PodDisruptionBudget` (minAvailable=1)
- `ServiceAccount` with Workload Identity to access Cloud SQL +
  Secret Manager (if on GKE) or with `imagePullSecrets` for non-GKE

Postgres + GCS + Vertex AI remain external to the cluster — no in-cluster
DB or object-store.
