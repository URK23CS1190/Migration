const { EC2Client, StopInstancesCommand, StartInstancesCommand } =
  require('@aws-sdk/client-ec2');

require('dotenv').config();

const client = new EC2Client({
  region: process.env.REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const PRIMARY_INSTANCE = 'i-0efebca05222294c5';

async function stopPrimaryInstance() {
  const res = await client.send(
    new StopInstancesCommand({
      InstanceIds: [PRIMARY_INSTANCE]
    })
  );
  return res.StoppingInstances?.[0]?.CurrentState?.Name;
}

async function startPrimaryInstance() {
  const res = await client.send(
    new StartInstancesCommand({
      InstanceIds: [PRIMARY_INSTANCE]
    })
  );
  return res.StartingInstances?.[0]?.CurrentState?.Name;
}

module.exports = { stopPrimaryInstance, startPrimaryInstance };