variable "region" {
  description = "Tencent region shared by staging and pilot."
  type        = string
  default     = "ap-shanghai"
}

variable "availability_zones" {
  description = "One EKS-CI-capable availability zone per environment."
  type        = map(string)
  validation {
    condition     = alltrue([for env in ["staging", "pilot"] : contains(keys(var.availability_zones), env)])
    error_message = "availability_zones must contain staging and pilot."
  }
}

variable "vpc_cidrs" {
  type    = map(string)
  default = { staging = "10.80.0.0/16", pilot = "10.81.0.0/16" }
}

variable "subnet_cidrs" {
  type    = map(string)
  default = { staging = "10.80.10.0/24", pilot = "10.81.10.0/24" }
}

variable "cam_user_names" {
  description = "Pre-created CAM users. Terraform attaches policy but never creates access keys."
  type        = map(string)
  validation {
    condition     = alltrue([for env in ["staging", "pilot"] : contains(keys(var.cam_user_names), env) && length(var.cam_user_names[env]) > 0])
    error_message = "cam_user_names must contain non-empty staging and pilot user names."
  }
}

variable "tcr_instance_name" {
  type    = string
  default = "scan-agent-p1"
}

variable "tcr_namespace" {
  type    = string
  default = "scan-agent"
}

variable "tcr_repository" {
  type    = string
  default = "scan-agent"
}

variable "tags" {
  type    = map(string)
  default = { system = "cloudflare-scan-mvp", managed_by = "terraform" }
}
