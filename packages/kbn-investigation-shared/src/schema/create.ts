/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import * as t from 'io-ts';
import { investigationResponseSchema } from './investigation';
import { alertOriginSchema, blankOriginSchema } from './origin';

const createInvestigationParamsSchema = t.type({
  body: t.type({
    id: t.string,
    title: t.string,
    params: t.type({
      timeRange: t.type({ from: t.number, to: t.number }),
    }),
    origin: t.union([alertOriginSchema, blankOriginSchema]),
  }),
});

const createInvestigationResponseSchema = investigationResponseSchema;

type CreateInvestigationInput = t.OutputOf<typeof createInvestigationParamsSchema.props.body>; // Raw payload sent by the frontend
type CreateInvestigationParams = t.TypeOf<typeof createInvestigationParamsSchema.props.body>; // Parsed payload used by the backend
type CreateInvestigationResponse = t.OutputOf<typeof createInvestigationResponseSchema>; // Raw response sent to the frontend

export { createInvestigationParamsSchema, createInvestigationResponseSchema };
export type { CreateInvestigationInput, CreateInvestigationParams, CreateInvestigationResponse };
