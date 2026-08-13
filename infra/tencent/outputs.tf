output "environment_runtime" {
  value = {
    for env in ["staging", "pilot"] : env => {
      region             = var.region
      vpc_id             = tencentcloud_vpc.scan[env].id
      subnet_id          = tencentcloud_subnet.scan[env].id
      security_group_ids = [tencentcloud_security_group.scan[env].id]
      egress_model       = "one auto-created EIP per EKS container instance; released with the instance"
      cam_user_name      = var.cam_user_names[env]
    }
  }
}

output "secret_handling" {
  value = "Create CAM access keys outside Terraform and store them only in protected GitHub environments and Wrangler secrets. The public GHCR image requires no registry credential."
}
