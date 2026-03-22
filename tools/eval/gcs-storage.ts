import { Storage } from '@google-cloud/storage';

const storage = new Storage();

/**
 * Uploads a JSON object to a Google Cloud Storage bucket
 * @param bucketName Name of the GCS bucket
 * @param destFileName The destination path in the bucket
 * @param jsonData The JSON object to upload
 */
export async function uploadResultsToGCS(bucketName: string, destFileName: string, jsonData: any): Promise<void> {
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(destFileName);

    console.log(`Uploading results to gs://${bucketName}/${destFileName}...`);
    
    await file.save(JSON.stringify(jsonData, null, 2), {
      metadata: {
        contentType: 'application/json',
      },
      // Resumeable uploads aren't necessary for small JSON
      resumable: false, 
    });

    console.log('✅ Upload complete.');
  } catch (error) {
    console.error('Failed to upload results to GCS.', error);
    throw error;
  }
}

/**
 * Ensures a bucket exists, creating it if necessary
 */
export async function ensureBucketExists(bucketName: string): Promise<void> {
  try {
    const bucket = storage.bucket(bucketName);
    const [exists] = await bucket.exists();
    if (!exists) {
      console.log(`Bucket ${bucketName} does not exist. Creating it...`);
      await bucket.create();
      console.log(`✅ Created bucket ${bucketName}.`);
    } else {
      console.log(`ℹ️ Bucket ${bucketName} already exists.`);
    }
  } catch (error) {
    console.error(`Failed to ensure bucket ${bucketName} exists.`, error);
    throw error;
  }
}
