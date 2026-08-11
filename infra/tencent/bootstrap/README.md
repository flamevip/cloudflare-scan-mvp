# Tencent COS state bootstrap

This one-time stack creates the private, AES-256 encrypted, versioned COS bucket used by the main Tencent stack. It deliberately has `prevent_destroy` and never creates CAM access keys.

Bootstrap with local state, retain that state securely, then migrate it into the new bucket:

```bash
terraform -chdir=infra/tencent/bootstrap init -backend=false
terraform -chdir=infra/tencent/bootstrap apply -var="state_bucket=<name-appid>"
terraform -chdir=infra/tencent/bootstrap init -migrate-state -backend-config=backend.hcl
```

Do not run bootstrap from an ephemeral CI runner. Subsequent changes must initialize directly against the COS backend.
