output "environment_runtime" {
  value = {
    for env in ["staging", "pilot"] : env => {
      region             = var.region
      vpc_id             = tencentcloud_vpc.scan[env].id
      subnet_id          = tencentcloud_subnet.scan[env].id
      security_group_ids = [tencentcloud_security_group.scan[env].id]
      egress_model       = "one auto-created EIP per EKS container instance; EKS release plus exact VPC orphan cleanup"
      cam_user_name      = var.cam_user_names[env]
    }
  }
}

output "secret_handling" {
  value = "Create CAM access keys outside Terraform and store them only in protected GitHub environments and Wrangler secrets. The public Alibaba Cloud ACR image requires no registry credential at EKS runtime."
}
