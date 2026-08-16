# Tencent P1 infrastructure

This root creates isolated staging and pilot VPC/subnet/security-group resources and least-privilege CAM policies. GitHub Actions publishes Agent images separately to the public Alibaba Cloud Container Registry repository in Chengdu. It never creates TCR, shared NAT gateways, shared EIPs, or CAM access keys.

1. Use `bootstrap/` once to create the private, AES-256 encrypted, versioned COS state bucket, then migrate the bootstrap state into it.
2. Copy `backend.hcl.example` and `terraform.tfvars.example` outside the repository or to ignored filenames.
3. Create the named CAM users without access keys.
4. Run `terraform init -backend-config=backend.hcl`, `terraform plan`, and an approved `terraform apply`.
5. Create access keys once, put them directly into the matching protected GitHub Environment and Wrangler secrets, then discard the plaintext copy.
6. Build and sign one public Alibaba Cloud ACR agent digest. Use that exact digest in both staging and pilot; ACR push credentials stay in the protected `agent-image-publish` GitHub Environment and no registry credential is passed to EKS CI.

Each EKS container instance is launched by the Worker with its own auto-created EIP. `Replicas=1`, so concurrent containers do not share an egress address. The Worker requests EIP release when it deletes the instance, then uses the recorded EIP ID or exact observed public IP to verify the VPC address is absent and releases an unbound orphan when necessary. The CAM policy therefore permits only `vpc:DescribeAddresses` and `vpc:ReleaseAddresses` in addition to the EKS CI lifecycle actions. Cleanup retries cover terminal, cancelled, and timed-out runs. Tencent may later reuse a released address, and the address is only known after creation.

The protected infrastructure workflow includes a one-time `forget-retired-tcr-state` action for the three historical TCR addresses that were deleted when the project stopped using TCR. It uploads a seven-day pre-change state backup, removes only those fixed addresses from Terraform state, and never creates or deletes a Tencent resource. The COS backend also retains version history.

The ordered security-group rule set has no inbound access and rejects private, carrier-grade NAT, loopback, link-local, and metadata ranges before allowing public egress. Confirm EIP attachment, rule priority, DNS reachability, callback IP recording, and EIP release with a staging mock before pilot promotion.

The Terraform provider is pinned to `1.83.21`; CI resolves and validates that exact provider version. Never run `apply` from a pull-request workflow.
