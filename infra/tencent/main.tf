locals {
  environments = toset(["staging", "pilot"])
}

resource "tencentcloud_vpc" "scan" {
  for_each   = local.environments
  name       = "scan-${each.key}"
  cidr_block = var.vpc_cidrs[each.key]
  tags       = merge(var.tags, { environment = each.key })
}

resource "tencentcloud_subnet" "scan" {
  for_each          = local.environments
  name              = "scan-${each.key}-private"
  vpc_id            = tencentcloud_vpc.scan[each.key].id
  cidr_block        = var.subnet_cidrs[each.key]
  availability_zone = var.availability_zones[each.key]
  is_multicast      = false
  tags              = merge(var.tags, { environment = each.key })
}

resource "tencentcloud_security_group" "scan" {
  for_each    = local.environments
  name        = "scan-${each.key}-eksci"
  description = "No inbound traffic; public egress with private and metadata ranges denied."
  project_id  = 0
  tags        = merge(var.tags, { environment = each.key })
}

resource "tencentcloud_security_group_rule_set" "scan" {
  for_each          = local.environments
  security_group_id = tencentcloud_security_group.scan[each.key].id

  ingress {
    action      = "DROP"
    cidr_block  = "0.0.0.0/0"
    protocol    = "ALL"
    port        = "ALL"
    description = "Deny all inbound traffic"
  }

  # Rule-set blocks are ordered. Private, loopback, CGNAT, link-local and
  # metadata destinations must be evaluated before the public allow rule.
  dynamic "egress" {
    for_each = ["10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]
    content {
      action      = "DROP"
      cidr_block  = egress.value
      protocol    = "ALL"
      port        = "ALL"
      description = "Deny private, loopback, CGNAT, link-local, and metadata egress"
    }
  }

  egress {
    action      = "ACCEPT"
    cidr_block  = "0.0.0.0/0"
    protocol    = "ALL"
    port        = "ALL"
    description = "Allow public DNS, registry, callback, and authorized targets"
  }
}

resource "tencentcloud_cam_policy" "eks_ci_runner" {
  for_each    = local.environments
  name        = "scan-${each.key}-eks-ci-runner"
  description = "Minimum Tencent EKS CI lifecycle and exact orphan EIP cleanup operations for the scan Worker."
  document = jsonencode({
    version = "2.0"
    statement = [{
      effect = "allow"
      action = [
        "tke:CreateEKSContainerInstances",
        "tke:DescribeEKSContainerInstanceEvent",
        "tke:DescribeEKSContainerInstances",
        "tke:DeleteEKSContainerInstances",
        "cvm:DescribeAddresses",
        "cvm:ReleaseAddresses"
      ]
      resource = ["*"]
    }]
  })
}

resource "tencentcloud_cam_user_policy_attachment" "eks_ci_runner" {
  for_each  = local.environments
  user_name = var.cam_user_names[each.key]
  policy_id = tencentcloud_cam_policy.eks_ci_runner[each.key].id
}
