output "state_bucket" {
  value = tencentcloud_cos_bucket.terraform_state.bucket
}

output "state_bucket_url" {
  value = tencentcloud_cos_bucket.terraform_state.cos_bucket_url
}

output "controls" {
  value = {
    acl                    = "private"
    server_side_encryption = "AES256"
    versioning             = true
    prevent_destroy        = true
  }
}
