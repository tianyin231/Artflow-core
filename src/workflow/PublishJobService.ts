import { BilibiliPublishPackage } from './types';
import { withWorkflowDatabase } from './workflow-store';
import { PublishJobRecord } from '../storage/repositories/WorkflowRepository';
import { NotConfiguredBilibiliOpenPlatformPublisher } from './publishers/BilibiliOpenPlatformPublisher';

export class PublishJobService {
  public listJobs(): PublishJobRecord[] {
    return withWorkflowDatabase((database) => database.listPublishJobs());
  }

  public getJob(id: string): PublishJobRecord | null {
    return withWorkflowDatabase((database) => database.getPublishJob(id));
  }

  public createFromPackage(taskId: string, publishPackage: BilibiliPublishPackage): PublishJobRecord {
    const now = new Date().toISOString();
    const job: PublishJobRecord = {
      id: `pub_${taskId}`,
      taskId,
      status: 'ready',
      platform: 'bilibili',
      title: publishPackage.title,
      payload: publishPackage,
      createdAt: now,
      updatedAt: now,
    };
    return withWorkflowDatabase((database) => database.upsertPublishJob(job));
  }

  public cancelJob(id: string): PublishJobRecord {
    const job = withWorkflowDatabase((database) => database.updatePublishJob(id, { status: 'cancelled' }));
    if (!job) {
      throw new Error(`Publish job ${id} not found`);
    }
    return job;
  }

  public async submitJob(id: string): Promise<PublishJobRecord> {
    const job = this.getJob(id);
    if (!job) {
      throw new Error(`Publish job ${id} not found`);
    }
    if (job.status !== 'ready' && job.status !== 'failed') {
      throw new Error(`Publish job ${id} is not ready to submit`);
    }
    const credentials = withWorkflowDatabase((database) => database.getBilibiliPublishSettings()) ?? {};
    const publisher = new NotConfiguredBilibiliOpenPlatformPublisher(credentials);
    const result = await publisher.publishVideo(job.payload as BilibiliPublishPackage);
    const status = result.status === 'submitted' || result.status === 'queued' ? 'submitted' : 'failed';
    const updated = withWorkflowDatabase((database) =>
      database.updatePublishJob(id, {
        status,
        result,
        error: status === 'failed' ? result.message : undefined,
      })
    );
    if (!updated) {
      throw new Error(`Publish job ${id} not found`);
    }
    return updated;
  }
}

export const publishJobService = new PublishJobService();
