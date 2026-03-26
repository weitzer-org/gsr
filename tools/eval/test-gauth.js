const { GoogleAuth } = require('google-auth-library');

async function testFetchStagingUrl() {
  console.log('Testing Google Auth Library fetch payload locally...');
  try {
    const auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform'
    });
    const authClient = await auth.getClient();
    const projectId = await auth.getProjectId();
    console.log(`Resolved Project ID natively: ${projectId}`);

    // Since we don't want to actually trigger a full 10-minute build, 
    // we just test fetching the url of an arbitrary public service, 
    // or we just fetch the ADK backend service directly as a mock.
    const serviceName = 'gsr-code-review';
    
    console.log(`Sending mocked REST request to run.googleapis.com for service: ${serviceName}`);
    const res = await authClient.request({
      url: `https://run.googleapis.com/v1/projects/${projectId}/locations/us-central1/services/${serviceName}`
    });
    
    if (!res.data || !res.data.status || !res.data.status.url) {
      throw new Error('Could not extract Cloud Run URL from GCP API response.');
    }
    
    console.log('✅ Success! Extracted Cloud Run Staging URL:', res.data.status.url);
    
  } catch (err) {
    console.error('❌ Integration Test Failed:', err.message);
  }
}

testFetchStagingUrl();
