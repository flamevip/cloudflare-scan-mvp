variable "region" {
  description = "COS state bucket region."
  type        = string
  default     = "ap-chengdu"
}

variable "state_bucket" {
  description = "Globally unique COS bucket name including the Tencent app ID suffix."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,48}-[0-9]{5,}$", var.state_bucket))
    error_message = "state_bucket must be a valid COS bucket name ending in the Tencent app ID."
  }
}

variable "tags" {
  type    = map(string)
  default = { system = "cloudflare-scan-mvp", managed_by = "terraform", purpose = "terraform-state" }
}
