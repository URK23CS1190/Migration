# AEGIS — Complete Implementation Guide
## Day-by-Day Setup: AWS Multi-Region Failover

---

## Architecture

```
Your PC (local)
      ↓ git push
GitHub Actions (CI/CD)
      ↓ builds Docker image
Docker Hub
      ↓ pulls image
┌─────────────────────────────────────────────────────────┐
│                    Route 53 (DNS + Health Check)        │
│              /health polls every 30s                    │
└────────────────────┬────────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
    PRIMARY EC2              SECONDARY EC2
   us-east-1                ap-south-1
   (N. Virginia)            (Mumbai)
   t2.micro                 t2.micro
         ↓                         ↓
   Docker Container          Docker Container
   aegis-app:3000            aegis-app:3000
         ↓                         ↓
   Node Exporter:9100        Node Exporter:9100
         ↓                         ↓
         └──────── Prometheus:9090 ─────────┘
                        ↓
                  Grafana:3001
```

---

# DAY 1 — Local Setup & Dashboard ✅ (ALREADY DONE)

Login: `admin / cloud123`

**Test it:**
```bash
npm install
npm start
# Open http://localhost:3000
```

---

# DAY 2 — Dockerize & Push to Docker Hub

## Step 1: Create Docker Hub account
- Go to https://hub.docker.com → Sign Up (free)
- Create a repository named `aegis-cloud`

## Step 2: Install Docker on your PC
```bash
# On Ubuntu/Linux:
sudo apt update
sudo apt install -y docker.io
sudo systemctl start docker
sudo usermod -aG docker $USER
newgrp docker        # Apply group without logout

# Test:
docker --version
```

## Step 3: Build Docker image
```bash
# Run this from the aegis-cloud folder
cd aegis-cloud

# Build the image
# EDIT: Replace YOUR_DOCKERHUB_USERNAME with your Docker Hub username
docker build -t YOUR_DOCKERHUB_USERNAME/aegis-cloud:latest .

# Example: docker build -t alfinjones/aegis-cloud:latest .
```

**If error: "permission denied"**
```bash
sudo chmod 666 /var/run/docker.sock
```

**If error: "Cannot connect to Docker daemon"**
```bash
sudo systemctl start docker
sudo systemctl enable docker
```

## Step 4: Test locally
```bash
# EDIT: Replace YOUR_DOCKERHUB_USERNAME
docker run -d -p 3000:3000 \
  -e REGION=us-east-1 \
  --name aegis-test \
  YOUR_DOCKERHUB_USERNAME/aegis-cloud:latest

# Open http://localhost:3000 — should work
docker logs aegis-test     # Check logs
docker stop aegis-test     # Stop when done
```

## Step 5: Push to Docker Hub
```bash
# Login
docker login
# Enter your Docker Hub username and password

# Push
# EDIT: Replace YOUR_DOCKERHUB_USERNAME
docker push YOUR_DOCKERHUB_USERNAME/aegis-cloud:latest
```

**If push fails with "denied":**
```bash
docker logout
docker login
# Try push again
```

---

# DAY 3 — AWS Account Setup

## Step 1: Create AWS Free Tier account
- Go to https://aws.amazon.com → Create Free Tier Account
- Add a credit/debit card (won't be charged for free tier)
- Select "Basic Support" (free)

## Step 2: Create IAM User (don't use root)
1. AWS Console → IAM → Users → Create User
2. Username: `aegis-admin`
3. Permissions: Attach `AdministratorAccess`
4. Create Access Key → Download CSV (save it safely!)

## Step 3: Install AWS CLI on your PC
```bash
# Ubuntu/Linux:
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# Configure with your keys
aws configure
# AWS Access Key ID: [paste from CSV]
# AWS Secret Access Key: [paste from CSV]
# Default region: us-east-1
# Default output format: json

# Test:
aws sts get-caller-identity
```

## Step 4: Create EC2 Key Pair (for SSH)
```bash
# This creates a key named "aegis-key" — SAVE THE .pem FILE!
aws ec2 create-key-pair \
  --key-name aegis-key \
  --query 'KeyMaterial' \
  --output text > aegis-key.pem

chmod 400 aegis-key.pem

# Do the same for Mumbai region:
aws ec2 create-key-pair \
  --region ap-south-1 \
  --key-name aegis-key \
  --query 'KeyMaterial' \
  --output text > aegis-key-mumbai.pem

chmod 400 aegis-key-mumbai.pem
```

**IMPORTANT: Store .pem files safely. You cannot download them again.**

---

# DAY 4 — Terraform Setup & Deploy Infrastructure

## Step 1: Install Terraform
```bash
# Ubuntu/Linux:
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install terraform

# Test:
terraform --version
```

## Step 2: Edit main.tf
Open `terraform/main.tf` and edit:
1. Line with `default = "aegis-key"` → Change to your key pair name
2. Line with `default = "YOURDOCKERHUBUSERNAME/aegis-cloud:latest"` → Replace with your username

## Step 3: Apply Terraform
```bash
cd terraform

# Initialize (downloads AWS provider)
terraform init

# Preview what will be created
terraform plan

# Create all infrastructure (takes 3-5 mins)
terraform apply
# Type "yes" when asked

# Note the output IPs:
# primary_ec2_ip = "x.x.x.x"
# secondary_ec2_ip = "y.y.y.y"
```

**If error: "Error configuring the backend"**
```bash
rm -rf .terraform
terraform init
```

**If error: "InvalidKeyPair.NotFound"**
- Make sure you created the key pair in BOTH regions (us-east-1 AND ap-south-1)
- Key pair name in main.tf must match exactly

**If error: "UnauthorizedOperation"**
```bash
aws sts get-caller-identity
# If this fails, re-run: aws configure
```

## Step 4: Verify EC2 instances
```bash
# Get your IPs from terraform output
terraform output

# SSH into primary (wait 2-3 mins after creation):
# EDIT: Replace PRIMARY_IP with your actual IP
ssh -i aegis-key.pem ubuntu@PRIMARY_IP

# Once inside, verify Docker is running:
docker ps
# Should show aegis-app container

# Check app:
curl http://localhost:3000/health
# Should return JSON with status: healthy

# Exit SSH:
exit
```

**If SSH times out:**
```bash
# Wait 2-3 more minutes, then try again
# EC2 needs time to finish user_data script
```

---

# DAY 5 — Route 53 Failover Setup

## Step 1: Get a free domain
Option A: Use `nip.io` (no registration needed — skip DNS setup, use IPs directly)
Option B: Register at https://freedns.afraid.org (free .mooo.com domain)
Option C: Buy a cheap .in domain on GoDaddy (~₹100/year)

For academic purposes, you can demo with IP addresses directly.

## Step 2: Create Route 53 Hosted Zone
```bash
# If you have a domain (replace yourdomain.com):
aws route53 create-hosted-zone \
  --name yourdomain.com \
  --caller-reference $(date +%s)

# Note the HostedZoneId from output
```

## Step 3: Create Failover DNS Records (AWS Console is easier)
1. AWS Console → Route 53 → Hosted Zones → Your Zone
2. Create Record:
   - Record name: `app.yourdomain.com`
   - Type: A
   - Value: `PRIMARY_EC2_IP`
   - Routing policy: **Failover**
   - Failover record type: **Primary**
   - Health check: Select `aegis-primary-health-check`
3. Create another Record:
   - Same name: `app.yourdomain.com`
   - Type: A
   - Value: `SECONDARY_EC2_IP`
   - Routing policy: **Failover**
   - Failover record type: **Secondary**
   - No health check needed

## Step 4: Test health check
```bash
# Check health check status:
aws route53 list-health-checks
# Status should show "Healthy"

# Test failover manually:
# 1. SSH into primary EC2
ssh -i aegis-key.pem ubuntu@PRIMARY_IP

# 2. Stop the app
docker stop aegis-app

# 3. Wait 60-90 seconds
# 4. Access your domain — should now load from secondary!
# 5. Restart primary:
docker start aegis-app
```

---

# DAY 6 — Kubernetes Setup (Minikube on EC2)

## Step 1: Install kubectl on your PC
```bash
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
kubectl version --client
```

## Step 2: Install Minikube on Primary EC2
```bash
# SSH into primary EC2
ssh -i aegis-key.pem ubuntu@PRIMARY_IP

# Install kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Install Minikube
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube

# Start Minikube (uses Docker driver)
minikube start --driver=docker

# If error "docker: permission denied":
sudo usermod -aG docker ubuntu && newgrp docker
minikube start --driver=docker
```

## Step 3: Deploy your app to Kubernetes
```bash
# Copy kubernetes/deployment.yaml to EC2, then:
# EDIT deployment.yaml: Replace YOURDOCKERHUBUSERNAME with your username first!

# Apply the deployment
kubectl apply -f deployment.yaml

# Check pods (wait 1-2 mins):
kubectl get pods -n aegis

# Expected output:
# NAME                        READY   STATUS    RESTARTS   AGE
# aegis-app-7d8b9c-xk2pq     1/1     Running   0          1m
# aegis-app-7d8b9c-mn9rt     1/1     Running   0          1m

# Check service:
kubectl get svc -n aegis
```

**If pods show "ImagePullBackOff":**
```bash
kubectl describe pod POD_NAME -n aegis
# Usually means Docker Hub image name is wrong
# Fix the image name in deployment.yaml, then:
kubectl apply -f deployment.yaml
```

**If pods show "CrashLoopBackOff":**
```bash
kubectl logs POD_NAME -n aegis
# Read the error and fix accordingly
```

## Step 4: Access the app via Kubernetes
```bash
# Get the NodePort URL
minikube service aegis-service -n aegis --url

# Or access via:
# http://EC2_IP:30080
```

## Useful Kubernetes Commands
```bash
kubectl get pods -n aegis                          # List pods
kubectl get pods -n aegis -o wide                  # With node info
kubectl describe pod POD_NAME -n aegis             # Pod details
kubectl logs POD_NAME -n aegis                     # Pod logs
kubectl logs POD_NAME -n aegis -f                  # Follow logs
kubectl exec -it POD_NAME -n aegis -- /bin/sh      # Shell into pod
kubectl delete pod POD_NAME -n aegis               # Delete pod (auto-restarts)
kubectl scale deployment aegis-app -n aegis --replicas=3  # Scale up
kubectl rollout restart deployment aegis-app -n aegis     # Restart deployment
kubectl get events -n aegis --sort-by='.lastTimestamp'    # Cluster events
minikube dashboard                                          # Visual UI
```

---

# DAY 7 — Prometheus + Grafana Monitoring

## Step 1: Edit prometheus.yml
Open `monitoring/prometheus/prometheus.yml`:
- Replace `PRIMARY_EC2_IP` with your actual primary EC2 IP
- Replace `SECONDARY_EC2_IP` with your secondary EC2 IP

## Step 2: Install Prometheus on Primary EC2
```bash
ssh -i aegis-key.pem ubuntu@PRIMARY_IP

# Download Prometheus
wget https://github.com/prometheus/prometheus/releases/download/v2.47.0/prometheus-2.47.0.linux-amd64.tar.gz
tar xvf prometheus-2.47.0.linux-amd64.tar.gz
sudo cp prometheus-2.47.0.linux-amd64/prometheus /usr/local/bin/
sudo cp prometheus-2.47.0.linux-amd64/promtool   /usr/local/bin/

# Create config directory
sudo mkdir -p /etc/prometheus
# Upload your prometheus.yml here (use scp):
# Exit EC2 first, then from your PC:
# scp -i aegis-key.pem monitoring/prometheus/prometheus.yml ubuntu@PRIMARY_IP:/etc/prometheus/
# SSH back in:

# Create systemd service
sudo tee /etc/systemd/system/prometheus.service > /dev/null <<'EOF'
[Unit]
Description=Prometheus
After=network.target

[Service]
User=ubuntu
ExecStart=/usr/local/bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/var/lib/prometheus
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo mkdir -p /var/lib/prometheus
sudo chown ubuntu:ubuntu /var/lib/prometheus
sudo systemctl daemon-reload
sudo systemctl enable prometheus
sudo systemctl start prometheus

# Test: Open http://PRIMARY_IP:9090 in browser
```

## Step 3: Install Grafana on Primary EC2
```bash
# Still on primary EC2:
sudo apt-get install -y adduser libfontconfig1
wget https://dl.grafana.com/oss/release/grafana_10.1.0_amd64.deb
sudo dpkg -i grafana_10.1.0_amd64.deb
sudo systemctl enable grafana-server
sudo systemctl start grafana-server

# Access: http://PRIMARY_IP:3001
# Login: admin / admin (change on first login)
```

## Step 4: Configure Grafana
1. Open `http://PRIMARY_IP:3001`
2. Login: `admin` / `admin`
3. Add Data Source → Prometheus → URL: `http://localhost:9090` → Save
4. Create Dashboard → Add Panel
5. Query: `app_request_total{region="us-east-1"}` → Visualize!

**Useful Prometheus Queries for Grafana:**
```
app_uptime_seconds{region="us-east-1"}           # Uptime
app_active_users{region="us-east-1"}             # Users
app_memory_mb{region="us-east-1"}                # Memory
app_failover_total                                # Failover count
app_docker_containers_running                     # Docker containers
rate(app_request_total[1m])                      # Request rate
node_cpu_seconds_total{mode="idle"}              # CPU (from node_exporter)
100 - (avg by(instance)(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)  # CPU %
```

**If Prometheus shows targets as "DOWN":**
```bash
# Check if node_exporter is running on secondary:
ssh -i aegis-key.pem ubuntu@SECONDARY_IP
sudo systemctl status node_exporter
sudo systemctl start node_exporter

# Check firewall (Security Group) allows port 9100
```

---

# DAY 8 — GitHub Actions CI/CD

## Step 1: Push project to GitHub
```bash
cd aegis-cloud
git init
echo "node_modules/" > .gitignore
echo "*.pem" >> .gitignore
echo ".env" >> .gitignore
git add .
git commit -m "AEGIS v2.0 - Full infrastructure"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/aegis-cloud.git
git push -u origin main
```

## Step 2: Add GitHub Secrets
GitHub → Your repo → Settings → Secrets and variables → Actions → New secret

Add these secrets:
| Secret Name          | Value                          |
|----------------------|-------------------------------|
| DOCKERHUB_USERNAME   | your Docker Hub username       |
| DOCKERHUB_TOKEN      | Docker Hub access token*       |
| PRIMARY_EC2_IP       | your primary EC2 IP            |
| SECONDARY_EC2_IP     | your secondary EC2 IP          |
| EC2_SSH_KEY          | contents of aegis-key.pem**    |

*Docker Hub token: https://hub.docker.com → Account Settings → Security → New Token

**SSH key: `cat aegis-key.pem` → copy the entire output

## Step 3: Test CI/CD
```bash
# Make a small change to server.js, then:
git add .
git commit -m "Test CI/CD pipeline"
git push

# Go to GitHub → Actions → Watch the pipeline run
# Both EC2s will auto-update!
```

---

# DAY 9 — Final Demo & Review Prep

## Live Demo Script (Show this to reviewers)

**Step 1:** Open dashboard → `http://YOUR_DOMAIN:3000`
```
"Our Node.js app is running in a Docker container on the primary region
us-east-1 (N. Virginia), monitored by Prometheus and Grafana."
```

**Step 2:** Show Kubernetes pods
```bash
kubectl get pods -n aegis
```
```
"Kubernetes manages 2 replicas of our app for high availability with
auto-scaling configured up to 5 replicas under load."
```

**Step 3:** Show Grafana dashboard
```
"Prometheus scrapes /metrics every 15 seconds from both regions.
Grafana shows real-time CPU, memory, and request traffic."
```

**Step 4:** Simulate disaster
```
"I'll now simulate a regional disaster by stopping the primary EC2."
```
```bash
# Stop primary EC2 app
ssh -i aegis-key.pem ubuntu@PRIMARY_IP
docker stop aegis-app
exit
```

**Step 5:** Show Route 53 health check failing (60-90 sec)
**Step 6:** Refresh app URL → still works from secondary!
**Step 7:** Restore primary
```bash
ssh -i aegis-key.pem ubuntu@PRIMARY_IP
docker start aegis-app
```

**Review Statement:**
> "This project implements autonomous multi-region disaster recovery using AWS.
> The application is containerized in Docker, managed by Kubernetes for 
> high availability, provisioned via Terraform as Infrastructure-as-Code, 
> deployed automatically through GitHub Actions CI/CD, and monitored using 
> Prometheus and Grafana. Route 53 health checks detect primary failure 
> within 90 seconds and automatically reroute DNS to the secondary region 
> in Mumbai — all with zero manual intervention."

---

# Quick Reference — All Commands

## Docker
```bash
docker build -t USERNAME/aegis-cloud:latest .   # Build image
docker push USERNAME/aegis-cloud:latest          # Push to Hub
docker run -d -p 3000:3000 IMAGE                 # Run container
docker ps                                         # List containers
docker logs CONTAINER_NAME                        # View logs
docker stop CONTAINER_NAME                        # Stop container
docker start CONTAINER_NAME                       # Start container
docker exec -it CONTAINER_NAME /bin/sh           # Shell into container
docker system prune -f                            # Clean up
```

## Kubernetes
```bash
kubectl apply -f deployment.yaml                  # Deploy
kubectl get pods -n aegis                         # List pods
kubectl get svc -n aegis                          # List services
kubectl describe pod POD_NAME -n aegis            # Pod details
kubectl logs POD_NAME -n aegis -f                 # Follow logs
kubectl scale deployment aegis-app --replicas=3   # Scale
kubectl delete deployment aegis-app -n aegis      # Delete deployment
minikube start/stop/status/dashboard              # Minikube control
```

## Terraform
```bash
terraform init                  # Initialize
terraform plan                  # Preview changes
terraform apply                 # Apply (create/update)
terraform destroy               # Destroy all resources
terraform output                # Show outputs (IPs)
terraform state list            # List resources in state
```

## AWS CLI
```bash
aws ec2 describe-instances --region us-east-1     # List EC2s
aws ec2 stop-instances --instance-ids i-xxx       # Stop instance
aws ec2 start-instances --instance-ids i-xxx      # Start instance
aws route53 list-health-checks                     # List health checks
```

---

## Cost Control — Stay Free
- Stop EC2 instances when not needed: `aws ec2 stop-instances --instance-ids i-xxx`
- Route 53 costs ≈ ₹80-100/month (only if you use a real domain)
- Everything else is free tier
- **Delete everything after review:** `terraform destroy`
