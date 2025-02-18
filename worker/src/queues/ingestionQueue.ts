import { Job, Processor } from "bullmq";
import {
  traceException,
  QueueName,
  recordIncrement,
  recordGauge,
  recordHistogram,
  TQueueJobTypes,
  logger,
  IngestionEventType,
  S3StorageService,
  ingestionBatchEvent,
  ingestionEvent,
  IngestionQueue,
  redis,
  clickhouseClient,
  getClickhouseEntityType,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";

import { env } from "../env";
import { IngestionService } from "../services/IngestionService";
import { ClickhouseWriter } from "../services/ClickhouseWriter";

let s3StorageServiceClient: S3StorageService;

const getS3StorageServiceClient = (bucketName: string): S3StorageService => {
  if (!s3StorageServiceClient) {
    s3StorageServiceClient = new S3StorageService({
      bucketName,
      accessKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY,
      endpoint: env.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT,
      region: env.LANGFUSE_S3_EVENT_UPLOAD_REGION,
      forcePathStyle: env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
    });
  }
  return s3StorageServiceClient;
};

export const ingestionQueueProcessor: Processor = async (
  job: Job<TQueueJobTypes[QueueName.IngestionQueue]>,
) => {
  try {
    const startTime = Date.now();

    if (
      env.LANGFUSE_S3_EVENT_UPLOAD_ENABLED !== "true" ||
      !env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET
    ) {
      throw new Error(
        "S3 event store is not enabled but useS3EventStore is true",
      );
    }

    const s3Client = getS3StorageServiceClient(
      env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET,
    );
    const eventName = job.data.payload.data.type.split("-").shift();
    if (!eventName) {
      throw new Error("Event name not found");
    }

    logger.info("Processing ingestion event", {
      projectId: job.data.payload.authCheck.scope.projectId,
      payload: job.data.payload.data,
    });

    // Download all events from folder into a local array
    const eventFiles = await s3Client.listFiles(
      `${env.LANGFUSE_S3_EVENT_UPLOAD_PREFIX}${job.data.payload.authCheck.scope.projectId}/${eventName}/${job.data.payload.data.eventBodyId}/`,
    );

    const events: IngestionEventType[] = (
      await Promise.all(
        eventFiles.map(async (key) => {
          const file = await s3Client.download(key);
          const parsedFile = JSON.parse(file);

          const parsed = ingestionBatchEvent.safeParse(parsedFile);
          if (parsed.success) {
            return parsed.data;
          } else {
            const parsed = ingestionEvent.safeParse(parsedFile);
            if (parsed.success) {
              return [parsed.data];
            } else {
              throw new Error(
                `Failed to parse event from S3: ${parsed.error.message}`,
              );
            }
          }
        }),
      )
    ).flat();

    if (events.length === 0) {
      logger.warn(
        `No events found for project ${job.data.payload.authCheck.scope.projectId} and event ${job.data.payload.data.eventBodyId}`,
      );
      return;
    }

    // Perform merge of those events
    if (!redis) throw new Error("Redis not available");
    if (!prisma) throw new Error("Prisma not available");
    await new IngestionService(
      redis,
      prisma,
      ClickhouseWriter.getInstance(),
      clickhouseClient,
    ).mergeAndWrite(
      getClickhouseEntityType(events[0]),
      job.data.payload.authCheck.scope.projectId,
      job.data.payload.data.eventBodyId,
      events,
    );

    const waitTime = Date.now() - job.timestamp;
    recordIncrement("langfuse.queue.ingestion.request");
    recordHistogram("langfuse.queue.ingestion.wait_time", waitTime, {
      unit: "milliseconds",
    });

    // Log queue size
    await IngestionQueue.getInstance()
      ?.count()
      .then((count) => {
        logger.debug(`Ingestion queue length: ${count}`);
        recordGauge("langfuse.queue.ingestion.length", count, {
          unit: "records",
        });
        return count;
      })
      .catch();
    recordHistogram(
      "langfuse.queue.ingestion.processing_time",
      Date.now() - startTime,
      { unit: "milliseconds" },
    );
  } catch (e) {
    logger.error(
      `Failed job ingestion processing for ${job.data.payload.authCheck.scope.projectId}`,
      e,
    );
    traceException(e);
    throw e;
  }
};
