/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod';

import { ESProcessorItem } from './processor_attributes';

/**
 * Package name for the integration to be built.
 */
export type PackageName = z.infer<typeof PackageName>;
export const PackageName = z.string().min(1);

/**
 * DataStream name for the integration to be built.
 */
export type DataStreamName = z.infer<typeof DataStreamName>;
export const DataStreamName = z.string().min(1);

/**
 * String array containing the json raw samples that are used for ecs mapping.
 */
export type RawSamples = z.infer<typeof RawSamples>;
export const RawSamples = z.array(z.string());

/**
 * mapping object to ECS Mapping Request.
 */
export type Mapping = z.infer<typeof Mapping>;
export const Mapping = z.object({}).passthrough();

/**
 * LLM Connector to be used in each API request.
 */
export type Connector = z.infer<typeof Connector>;
export const Connector = z.string();

/**
 * An array of processed documents.
 */
export type Docs = z.infer<typeof Docs>;
export const Docs = z.array(z.object({}).passthrough());

/**
 * The pipeline object.
 */
export type Pipeline = z.infer<typeof Pipeline>;
export const Pipeline = z.object({
  /**
   * The name of the pipeline.
   */
  name: z.string().optional(),
  /**
   * The description of the pipeline.
   */
  description: z.string().optional(),
  /**
   * The version of the pipeline.
   */
  version: z.number().int().optional(),
  /**
   * The processors to execute.
   */
  processors: z.array(ESProcessorItem),
  /**
   * The processors to execute if the pipeline fails.
   */
  on_failure: z.array(ESProcessorItem).optional(),
});

/**
 * The input type for the dataStream to pull logs from.
 */
export type InputType = z.infer<typeof InputType>;
export const InputType = z.enum([
  'aws-cloudwatch',
  'aws-s3',
  'azure-blob-storage',
  'azure-eventhub',
  'cel',
  'cloudfoundry',
  'filestream',
  'gcp-pubsub',
  'gcs',
  'http-endpoint',
  'journald',
  'kafka',
  'tcp',
  'udp',
]);
export type InputTypeEnum = typeof InputType.enum;
export const InputTypeEnum = InputType.enum;

/**
 * The dataStream object.
 */
export type DataStream = z.infer<typeof DataStream>;
export const DataStream = z.object({
  /**
   * The name of the dataStream.
   */
  name: z.string(),
  /**
   * The title of the dataStream.
   */
  title: z.string(),
  /**
   * The description of the dataStream.
   */
  description: z.string(),
  /**
   * The input types of the dataStream.
   */
  inputTypes: z.array(InputType),
  /**
   * The raw samples of the dataStream.
   */
  rawSamples: RawSamples,
  /**
   * The pipeline of the dataStream.
   */
  pipeline: Pipeline,
  /**
   * The documents of the dataStream.
   */
  docs: Docs,
});

/**
 * The integration object.
 */
export type Integration = z.infer<typeof Integration>;
export const Integration = z.object({
  /**
   * The name of the integration.
   */
  name: z.string(),
  /**
   * The title of the integration.
   */
  title: z.string(),
  /**
   * The description of the integration.
   */
  description: z.string(),
  /**
   * The dataStreams of the integration.
   */
  dataStreams: z.array(DataStream),
  /**
   * The logo of the integration.
   */
  logo: z.string().optional(),
});

/**
 * The LangSmith options object.
 */
export type LangSmithOptions = z.infer<typeof LangSmithOptions>;
export const LangSmithOptions = z.object({
  /**
   * The project name to use with tracing.
   */
  projectName: z.string(),
  /**
   * The api key for the project
   */
  apiKey: z.string(),
});
