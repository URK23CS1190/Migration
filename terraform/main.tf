# ╔══════════════════════════════════════════════════════════════════╗
# ║  AEGIS — Terraform Infrastructure                                ║
# ║  AWS Multi-Region: us-east-1 (Primary) + ap-south-1 (Secondary) ║
# ╚══════════════════════════════════════════════════════════════════╝

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ── Providers ────────────────────────────────────────────────────────────────
provider "aws" {
  alias  = "primary"
  region = var.primary_region
}

provider "aws" {
  alias  = "secondary"
  region = var.secondary_region
}

# ── Variables ─────────────────────────────────────────────────────────────────
variable "primary_region"   { default = "us-east-1" }
variable "secondary_region" { default = "ap-south-1" }
variable "instance_type"    { default = "t2.micro" }    # Free Tier
variable "key_name"         {
  description = "Your AWS EC2 Key Pair name (create in EC2 console first)"
  # EDIT THIS: Replace with your actual key pair name, e.g. "my-aegis-key"
  default = "aegis-key"
}
variable "dockerhub_image"  {
  description = "Docker Hub image to deploy"
  # EDIT THIS: Replace with your Docker Hub username, e.g. "yourname/aegis-cloud:latest"
  default = "YOURDOCKERHUBUSERNAME/aegis-cloud:latest"
}

# ── AMI Data Sources ──────────────────────────────────────────────────────────
# Ubuntu 22.04 LTS (Free Tier eligible)
data "aws_ami" "ubuntu_primary" {
  provider    = aws.primary
  most_recent = true
  owners      = ["099720109477"]  # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
  filter { name = "virtualization-type"; values = ["hvm"] }
}

data "aws_ami" "ubuntu_secondary" {
  provider    = aws.secondary
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
  filter { name = "virtualization-type"; values = ["hvm"] }
}

# ── PRIMARY REGION (us-east-1) ────────────────────────────────────────────────

# VPC
resource "aws_vpc" "primary" {
  provider             = aws.primary
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags = { Name = "aegis-primary-vpc", Project = "AEGIS" }
}

resource "aws_internet_gateway" "primary" {
  provider = aws.primary
  vpc_id   = aws_vpc.primary.id
  tags     = { Name = "aegis-primary-igw" }
}

resource "aws_subnet" "primary_public" {
  provider                = aws.primary
  vpc_id                  = aws_vpc.primary.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.primary_region}a"
  map_public_ip_on_launch = true
  tags                    = { Name = "aegis-primary-subnet" }
}

resource "aws_route_table" "primary" {
  provider = aws.primary
  vpc_id   = aws_vpc.primary.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.primary.id
  }
  tags = { Name = "aegis-primary-rt" }
}

resource "aws_route_table_association" "primary" {
  provider       = aws.primary
  subnet_id      = aws_subnet.primary_public.id
  route_table_id = aws_route_table.primary.id
}

resource "aws_security_group" "primary" {
  provider    = aws.primary
  name        = "aegis-primary-sg"
  description = "AEGIS Primary Security Group"
  vpc_id      = aws_vpc.primary.id

  ingress { from_port=22;   to_port=22;   protocol="tcp"; cidr_blocks=["0.0.0.0/0"]; description="SSH" }
  ingress { from_port=80;   to_port=80;   protocol="tcp"; cidr_blocks=["0.0.0.0/0"]; description="HTTP" }
  ingress { from_port=443;  to_port=443;  protocol="tcp"; cidr_blocks=["0.0.0.0/0"]; description="HTTPS" }
  ingress { from_port=3000; to_port=3000; protocol="tcp"; cidr_blocks=["0.0.0.0/0"]; description="Node App" }
  ingress { from_port=9090; to_port=9090; protocol="tcp"; cidr_blocks=["0.0.0.0/0"]; description="Prometheus" }
  ingress { from_port=3001; to_port=3001; protocol="tcp"; cidr_blocks=["0.0.0.0/0"]; description="Grafana" }
  ingress { from_port=9100; to_port=9100; protocol="tcp"; cidr_blocks=["0.0.0.0/0"]; description="Node Exporter" }
  egress  { from_port=0;    to_port=0;    protocol="-1";  cidr_blocks=["0.0.0.0/0"] }

  tags = { Name = "aegis-primary-sg" }
}

resource "aws_instance" "primary" {
  provider               = aws.primary
  ami                    = data.aws_ami.ubuntu_primary.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.primary_public.id
  vpc_security_group_ids = [aws_security_group.primary.id]

  # EDIT THIS: Replace YOURDOCKERHUBUSERNAME below
  user_data = <<-EOF
    #!/bin/bash
    apt-get update -y
    apt-get install -y docker.io docker-compose curl wget
    systemctl enable docker && systemctl start docker
    usermod -aG docker ubuntu

    # Install Node Exporter for Prometheus
    useradd --no-create-home --shell /bin/false node_exporter
    wget https://github.com/prometheus/node_exporter/releases/download/v1.7.0/node_exporter-1.7.0.linux-amd64.tar.gz
    tar xvf node_exporter-1.7.0.linux-amd64.tar.gz
    cp node_exporter-1.7.0.linux-amd64/node_exporter /usr/local/bin/
    chown node_exporter:node_exporter /usr/local/bin/node_exporter

    cat > /etc/systemd/system/node_exporter.service <<'SERVICE'
[Unit]
Description=Node Exporter
[Service]
User=node_exporter
ExecStart=/usr/local/bin/node_exporter
[Install]
WantedBy=multi-user.target
SERVICE

    systemctl daemon-reload
    systemctl enable node_exporter
    systemctl start node_exporter

    # Pull and run the app
    docker pull ${var.dockerhub_image}
    docker run -d --name aegis-app --restart always \
      -p 3000:3000 \
      -e REGION=us-east-1 \
      -e NODE_ENV=production \
      ${var.dockerhub_image}
  EOF

  tags = { Name = "aegis-primary-ec2", Region = "primary", Project = "AEGIS" }
}

# ── SECONDARY REGION (ap-south-1) ────────────────────────────────────────────

resource "aws_vpc" "secondary" {
  provider             = aws.secondary
  cidr_block           = "10.1.0.0/16"
  enable_dns_hostnames = true
  tags = { Name = "aegis-secondary-vpc", Project = "AEGIS" }
}

resource "aws_internet_gateway" "secondary" {
  provider = aws.secondary
  vpc_id   = aws_vpc.secondary.id
  tags     = { Name = "aegis-secondary-igw" }
}

resource "aws_subnet" "secondary_public" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.secondary.id
  cidr_block              = "10.1.1.0/24"
  availability_zone       = "${var.secondary_region}a"
  map_public_ip_on_launch = true
  tags                    = { Name = "aegis-secondary-subnet" }
}

resource "aws_route_table" "secondary" {
  provider = aws.secondary
  vpc_id   = aws_vpc.secondary.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.secondary.id
  }
  tags = { Name = "aegis-secondary-rt" }
}

resource "aws_route_table_association" "secondary" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.secondary_public.id
  route_table_id = aws_route_table.secondary.id
}

resource "aws_security_group" "secondary" {
  provider    = aws.secondary
  name        = "aegis-secondary-sg"
  description = "AEGIS Secondary Security Group"
  vpc_id      = aws_vpc.secondary.id

  ingress { from_port=22;   to_port=22;   protocol="tcp"; cidr_blocks=["0.0.0.0/0"] }
  ingress { from_port=80;   to_port=80;   protocol="tcp"; cidr_blocks=["0.0.0.0/0"] }
  ingress { from_port=3000; to_port=3000; protocol="tcp"; cidr_blocks=["0.0.0.0/0"] }
  ingress { from_port=9100; to_port=9100; protocol="tcp"; cidr_blocks=["0.0.0.0/0"] }
  egress  { from_port=0;    to_port=0;    protocol="-1";  cidr_blocks=["0.0.0.0/0"] }

  tags = { Name = "aegis-secondary-sg" }
}

resource "aws_instance" "secondary" {
  provider               = aws.secondary
  ami                    = data.aws_ami.ubuntu_secondary.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.secondary_public.id
  vpc_security_group_ids = [aws_security_group.secondary.id]

  user_data = <<-EOF
    #!/bin/bash
    apt-get update -y
    apt-get install -y docker.io curl wget
    systemctl enable docker && systemctl start docker
    usermod -aG docker ubuntu

    # Node Exporter
    useradd --no-create-home --shell /bin/false node_exporter
    wget https://github.com/prometheus/node_exporter/releases/download/v1.7.0/node_exporter-1.7.0.linux-amd64.tar.gz
    tar xvf node_exporter-1.7.0.linux-amd64.tar.gz
    cp node_exporter-1.7.0.linux-amd64/node_exporter /usr/local/bin/
    chown node_exporter:node_exporter /usr/local/bin/node_exporter

    cat > /etc/systemd/system/node_exporter.service <<'SERVICE'
[Unit]
Description=Node Exporter
[Service]
User=node_exporter
ExecStart=/usr/local/bin/node_exporter
[Install]
WantedBy=multi-user.target
SERVICE

    systemctl daemon-reload
    systemctl enable node_exporter
    systemctl start node_exporter

    docker pull ${var.dockerhub_image}
    docker run -d --name aegis-app --restart always \
      -p 3000:3000 \
      -e REGION=ap-south-1 \
      -e NODE_ENV=production \
      ${var.dockerhub_image}
  EOF

  tags = { Name = "aegis-secondary-ec2", Region = "secondary", Project = "AEGIS" }
}

# ── ROUTE 53 Health Check + DNS Failover ──────────────────────────────────────
resource "aws_route53_health_check" "primary" {
  fqdn              = aws_instance.primary.public_dns
  port              = 3000
  type              = "HTTP"
  resource_path     = "/health"
  failure_threshold = 3
  request_interval  = 30
  tags              = { Name = "aegis-primary-health-check" }
}

# ── Outputs ────────────────────────────────────────────────────────────────────
output "primary_ec2_ip" {
  value       = aws_instance.primary.public_ip
  description = "Primary EC2 Public IP (us-east-1)"
}

output "secondary_ec2_ip" {
  value       = aws_instance.secondary.public_ip
  description = "Secondary EC2 Public IP (ap-south-1)"
}

output "primary_app_url" {
  value       = "http://${aws_instance.primary.public_ip}:3000"
  description = "Primary App URL"
}

output "secondary_app_url" {
  value       = "http://${aws_instance.secondary.public_ip}:3000"
  description = "Secondary App URL"
}
