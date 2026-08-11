# Tencent P1 infrastructure

This root creates isolated staging and pilot VPC/subnet/security-group/NAT resources, one shared private TCR repository, and least-privilege CAM policies. It never creates or exports CAM access keys.

1. Use `bootstrap/` once to create the private, AES-256 encrypted, versioned COS state bucket, then migrate the bootstrap state into it.
2. Copy `backend.hcl.example` and `terraform.tfvars.example` outside the repository or to ignored filenames.
3. Create the named CAM users without access keys.
4. Run `terraform init -backend-config=backend.hcl`, `terraform plan`, and an approved `terraform apply`.
5. Create access keys once, put them directly into the matching protected GitHub Environment and Wrangler secrets, then discard the plaintext copy.
6. Build and sign one agent digest. Use that exact digest in both staging and pilot.

The ordered security-group rule set has no inbound access and rejects private, carrier-grade NAT, loopback, link-local, and metadata ranges before allowing public egress. Confirm rule priority and DNS reachability with a staging mock before pilot promotion.

The Terraform provider is pinned to `1.83.21`; CI resolves and validates that exact provider version. Never run `apply` from a pull-request workflow.
