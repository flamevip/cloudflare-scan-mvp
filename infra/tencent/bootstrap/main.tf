resource "tencentcloud_cos_bucket" "terraform_state" {
  bucket               = var.state_bucket
  acl                  = "private"
  encryption_algorithm = "AES256"
  versioning_enable    = true
  force_clean          = false
  tags                 = var.tags

  lifecycle {
    prevent_destroy = true
  }
}
