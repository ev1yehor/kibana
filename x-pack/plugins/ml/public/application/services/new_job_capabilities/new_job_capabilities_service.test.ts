/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mlJobCapsServiceFactory } from './new_job_capabilities_service';
import type { DataView } from '@kbn/data-views-plugin/public';

import type { MlApi } from '../ml_api_service';

// there is magic happening here. starting the include name with `mock..`
// ensures it can be lazily loaded by the jest.mock function below.
import mockCloudwatchResponse from '../__mocks__/cloudwatch_job_caps_response.json';

const mlApiServicesMock = {
  jobs: {
    newJobCaps: jest.fn(() => Promise.resolve(mockCloudwatchResponse)),
  },
} as unknown as MlApi;

const dataView = {
  id: 'cloudwatch-*',
  getIndexPattern: () => 'cloudwatch-*',
} as unknown as DataView;

describe('new_job_capabilities_service', () => {
  describe('cloudwatch newJobCaps()', () => {
    it('can construct job caps objects from endpoint json', async () => {
      const newJobCapsService = mlJobCapsServiceFactory(mlApiServicesMock);
      await newJobCapsService.initializeFromDataVIew(dataView);
      const { fields, aggs } = await newJobCapsService.newJobCaps;

      const networkOutField = fields.find((f) => f.id === 'NetworkOut') || { aggs: [] };
      const regionField = fields.find((f) => f.id === 'region') || { aggs: [] };
      const meanAgg = aggs.find((a) => a.id === 'mean') || { fields: [] };
      const distinctCountAgg = aggs.find((a) => a.id === 'distinct_count') || { fields: [] };

      expect(fields).toHaveLength(12);
      expect(aggs).toHaveLength(35);

      expect(networkOutField.aggs).toHaveLength(25);
      expect(regionField.aggs).toHaveLength(3);

      expect(meanAgg.fields).toHaveLength(7);
      expect(distinctCountAgg.fields).toHaveLength(10);
    });

    it('job caps including text fields', async () => {
      const newJobCapsService = mlJobCapsServiceFactory(mlApiServicesMock);
      await newJobCapsService.initializeFromDataVIew(dataView, true, false);
      const { fields, aggs } = await newJobCapsService.newJobCaps;

      expect(fields).toHaveLength(13); // one more field
      expect(aggs).toHaveLength(35);
    });

    it('job caps excluding event rate', async () => {
      const newJobCapsService = mlJobCapsServiceFactory(mlApiServicesMock);
      await newJobCapsService.initializeFromDataVIew(dataView, false, true);
      const { fields, aggs } = await newJobCapsService.newJobCaps;

      expect(fields).toHaveLength(11); // one less field
      expect(aggs).toHaveLength(35);
    });
  });
});
