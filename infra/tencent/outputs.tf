output "environment_runtime" {
  value = {
    for env in ["staging", "pilot"] : env => {
      region             = var.region
      vpc_id             = tencentcloud_vpc.scan[env].id
      subnet_id          = tencentcloud_subnet.scan[env].id
      security_group_ids = [tencentcloud_security_group.scan[env].id]
      nat_eip            = tencentcloud_eip.nat[env].public_ip
      cam_user_name      = var.cam_user_names[env]
    }
  }
}

output "tcr_repository_url" {
  value = "${tencentcloud_tcr_instance.scan.public_domain}/${var.tcr_namespace}/${var.tcr_repository}"
}

output "secret_handling" {
  value = "Create CAM access keys and TCR robot credentials outside Terraform; store them only in protected GitHub environments and Wrangler secrets."
}
