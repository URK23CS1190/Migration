terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# =========================
# PROVIDERS (MULTI REGION)
# =========================

provider "aws" {
  region = "us-east-1"
}

provider "aws" {
  alias  = "secondary"
  region = "ap-south-1"
}

# =========================
# VARIABLES
# =========================

variable "instance_type" {
  default = "t2.micro"
}

variable "key_name" {
  type = string
}

variable "dockerhub_image" {
  type = string
}

# =========================
# AMI (FIX FOR YOUR ERROR)
# =========================

data "aws_ami" "amazon_linux_primary" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

data "aws_ami" "amazon_linux_secondary" {
  provider    = aws.secondary
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

# =========================
# SECURITY GROUP - PRIMARY
# =========================

resource "aws_security_group" "primary_sg" {
  name   = "primary-sg"
  vpc_id = data.aws_vpc.default.id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# =========================
# SECURITY GROUP - SECONDARY
# =========================

resource "aws_security_group" "secondary_sg" {
  provider = aws.secondary

  name   = "secondary-sg"
  vpc_id = data.aws_vpc.default_secondary.id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# =========================
# DEFAULT VPC LOOKUP
# =========================

data "aws_vpc" "default" {
  default = true
}

data "aws_vpc" "default_secondary" {
  provider = aws.secondary
  default  = true
}

# =========================
# EC2 PRIMARY
# =========================

resource "aws_instance" "primary" {
  ami           = data.aws_ami.amazon_linux_primary.id
  instance_type = var.instance_type
  key_name      = var.key_name

  vpc_security_group_ids = [aws_security_group.primary_sg.id]

  tags = {
    Name = "primary-instance"
  }
}

# =========================
# EC2 SECONDARY
# =========================

resource "aws_instance" "secondary" {
  provider      = aws.secondary
  ami           = data.aws_ami.amazon_linux_secondary.id
  instance_type = var.instance_type
  key_name      = var.key_name

  vpc_security_group_ids = [aws_security_group.secondary_sg.id]

  tags = {
    Name = "secondary-instance"
  }
}

# =========================
# OUTPUTS (FIXED)
# =========================

output "primary_ip" {
  value = aws_instance.primary.public_ip
}

output "secondary_ip" {
  value = aws_instance.secondary.public_ip
}