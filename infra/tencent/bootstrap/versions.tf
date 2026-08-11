terraform {
  required_version = ">= 1.7.0"

  required_providers {
    tencentcloud = {
      source  = "tencentcloudstack/tencentcloud"
      version = "= 1.83.21"
    }
  }

  backend "cos" {}
}

provider "tencentcloud" {
  region = var.region
}
