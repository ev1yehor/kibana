/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { IlmExplainLifecycleLifecycleExplain } from '@elastic/elasticsearch/lib/api/types';
import { omit } from 'lodash/fp';

import {
  FieldType,
  getDocsCount,
  getErrorSummary,
  getErrorSummaries,
  getErrorSummariesForRollup,
  getEnrichedFieldMetadata,
  getFieldTypes,
  getPatternIlmPhaseDescription,
  getIlmPhaseDescription,
  getIndexNames,
  getIsInSameFamily,
  getMissingTimestampFieldMetadata,
  getPartitionedFieldMetadata,
  getPartitionedFieldMetadataStats,
  getSizeInBytes,
  getTotalDocsCount,
  getTotalPatternIncompatible,
  getTotalPatternIndicesChecked,
  getTotalPatternSameFamily,
  getTotalSizeInBytes,
  isMappingCompatible,
  postStorageResult,
  getStorageResults,
  StorageResult,
  formatStorageResult,
} from './helpers';
import {
  hostNameWithTextMapping,
  hostNameKeyword,
  someField,
  someFieldKeyword,
  sourceIpWithTextMapping,
  sourceIpKeyword,
  sourcePort,
  timestamp,
  eventCategoryWithUnallowedValues,
} from './mock/enriched_field_metadata/mock_enriched_field_metadata';
import { mockIlmExplain } from './mock/ilm_explain/mock_ilm_explain';
import { mockMappingsProperties } from './mock/mappings_properties/mock_mappings_properties';
import { alertIndexNoResults } from './mock/pattern_rollup/mock_alerts_pattern_rollup';
import {
  packetbeatNoResults,
  packetbeatWithSomeErrors,
} from './mock/pattern_rollup/mock_packetbeat_pattern_rollup';
import {
  auditbeatNoResults,
  auditbeatWithAllResults,
} from './mock/pattern_rollup/mock_auditbeat_pattern_rollup';
import { mockStats } from './mock/stats/mock_stats';
import { mockStatsAuditbeatIndex } from './mock/stats/mock_stats_packetbeat_index';
import { mockStatsPacketbeatIndex } from './mock/stats/mock_stats_auditbeat_index';
import {
  COLD_DESCRIPTION,
  FROZEN_DESCRIPTION,
  HOT_DESCRIPTION,
  UNMANAGED_DESCRIPTION,
  WARM_DESCRIPTION,
} from './translations';
import {
  DataQualityCheckResult,
  EnrichedFieldMetadata,
  PartitionedFieldMetadata,
  PatternRollup,
  UnallowedValueCount,
} from './types';
import { httpServiceMock } from '@kbn/core-http-browser-mocks';
import { notificationServiceMock } from '@kbn/core-notifications-browser-mocks';
import { EcsFlatTyped } from './constants';
import { mockPartitionedFieldMetadataWithSameFamily } from './mock/partitioned_field_metadata/mock_partitioned_field_metadata_with_same_family';

describe('helpers', () => {
  describe('getTotalPatternSameFamily', () => {
    const baseResult: DataQualityCheckResult = {
      docsCount: 4,
      error: null,
      ilmPhase: 'unmanaged',
      incompatible: 3,
      indexName: 'auditbeat-custom-index-1',
      markdownComments: [
        '### auditbeat-custom-index-1\n',
        '| Result | Index | Docs | Incompatible fields | ILM Phase |\n|--------|-------|------|---------------------|-----------|\n| ❌ | auditbeat-custom-index-1 | 4 (0.0%) | 3 | `unmanaged` |\n\n',
        '### **Incompatible fields** `3` **Custom fields** `4` **ECS compliant fields** `2` **All fields** `9`\n',
        "#### 3 incompatible fields, 0 fields with mappings in the same family\n\nFields are incompatible with ECS when index mappings, or the values of the fields in the index, don't conform to the Elastic Common Schema (ECS), version 8.6.1.\n\nIncompatible fields with mappings in the same family have exactly the same search behavior but may have different space usage or performance characteristics.\n\nWhen an incompatible field is not in the same family:\n❌ Detection engine rules referencing these fields may not match them correctly\n❌ Pages may not display some events or fields due to unexpected field mappings or values\n❌ Mappings or field values that don't comply with ECS are not supported\n",
        '\n#### Incompatible field mappings - auditbeat-custom-index-1\n\n\n| Field | ECS mapping type (expected) | Index mapping type (actual) | \n|-------|-----------------------------|-----------------------------|\n| host.name | `keyword` | `text`  |\n| source.ip | `ip` | `text`  |\n\n#### Incompatible field values - auditbeat-custom-index-1\n\n\n| Field | ECS values (expected) | Document values (actual) | \n|-------|-----------------------|--------------------------|\n| event.category | `authentication`, `configuration`, `database`, `driver`, `email`, `file`, `host`, `iam`, `intrusion_detection`, `malware`, `network`, `package`, `process`, `registry`, `session`, `threat`, `vulnerability`, `web` | `an_invalid_category` (2),\n`theory` (1) |\n\n',
      ],
      pattern: 'auditbeat-*',
      sameFamily: 0,
      checkedAt: Date.now(),
    };

    it('returns undefined when results is undefined', () => {
      expect(getTotalPatternSameFamily(undefined)).toBeUndefined();
    });

    it('returns 0 when results is an empty object', () => {
      expect(getTotalPatternSameFamily({})).toBe(0);
    });

    it('should sum sameFamily values and return the total', () => {
      const results: Record<string, DataQualityCheckResult> = {
        a: {
          ...baseResult,
          indexName: 'a',
          markdownComments: [],
          pattern: 'pattern',
          sameFamily: 2,
        },
        b: {
          ...baseResult,
          indexName: 'b',
          markdownComments: [],
          pattern: 'pattern',
          sameFamily: 3,
        },
        c: { ...baseResult, indexName: 'c', markdownComments: [], pattern: 'pattern' },
      };

      expect(getTotalPatternSameFamily(results)).toBe(5);
    });

    it('handles a mix of defined and undefined sameFamily values', () => {
      const results: Record<string, DataQualityCheckResult> = {
        a: {
          ...baseResult,
          indexName: 'a',
          markdownComments: [],
          pattern: 'pattern',
          sameFamily: 1,
        },
        b: {
          ...baseResult,
          indexName: 'b',
          markdownComments: [],
          pattern: 'pattern',
          sameFamily: undefined,
        },
        c: {
          ...baseResult,
          indexName: 'c',
          markdownComments: [],
          pattern: 'pattern',
          sameFamily: 2,
        },
      };

      expect(getTotalPatternSameFamily(results)).toBe(3);
    });
  });

  describe('getIndexNames', () => {
    const isILMAvailable = true;
    const ilmPhases = ['hot', 'warm', 'unmanaged'];

    test('returns the expected index names when they have an ILM phase included in the ilmPhases list', () => {
      expect(
        getIndexNames({
          ilmExplain: mockIlmExplain, // <-- the mock indexes have 'hot' ILM phases
          ilmPhases,
          isILMAvailable,
          stats: mockStats,
        })
      ).toEqual([
        '.ds-packetbeat-8.6.1-2023.02.04-000001',
        '.ds-packetbeat-8.5.3-2023.02.04-000001',
        'auditbeat-custom-index-1',
      ]);
    });

    test('returns the expected filtered index names when they do NOT have an ILM phase included in the ilmPhases list', () => {
      expect(
        getIndexNames({
          ilmExplain: mockIlmExplain, // <-- the mock indexes have 'hot' and 'unmanaged' ILM phases...
          ilmPhases: ['warm', 'unmanaged'], // <-- ...but we don't ask for 'hot'
          isILMAvailable,
          stats: mockStats,
        })
      ).toEqual(['auditbeat-custom-index-1']); // <-- the 'unmanaged' index
    });

    test('returns the expected index names when the `ilmExplain` is missing a record for an index', () => {
      // the following `ilmExplain` is missing a record for one of the two packetbeat indexes:
      const ilmExplainWithMissingIndex: Record<string, IlmExplainLifecycleLifecycleExplain> = omit(
        '.ds-packetbeat-8.6.1-2023.02.04-000001',
        mockIlmExplain
      );

      expect(
        getIndexNames({
          ilmExplain: ilmExplainWithMissingIndex, // <-- the mock indexes have 'hot' ILM phases...
          ilmPhases: ['hot', 'warm', 'unmanaged'],
          isILMAvailable,
          stats: mockStats,
        })
      ).toEqual(['.ds-packetbeat-8.5.3-2023.02.04-000001', 'auditbeat-custom-index-1']); // <-- only includes two of the three indices, because the other one is missing an ILM explain record
    });

    test('returns empty index names when `ilmPhases` is empty', () => {
      expect(
        getIndexNames({
          ilmExplain: mockIlmExplain,
          ilmPhases: [],
          isILMAvailable,
          stats: mockStats,
        })
      ).toEqual([]);
    });

    test('returns empty index names when they have an ILM phase that matches', () => {
      expect(
        getIndexNames({
          ilmExplain: null,
          ilmPhases,
          isILMAvailable,
          stats: mockStats,
        })
      ).toEqual([]);
    });

    test('returns empty index names when just `stats` is null', () => {
      expect(
        getIndexNames({
          ilmExplain: mockIlmExplain,
          ilmPhases,
          isILMAvailable,
          stats: null,
        })
      ).toEqual([]);
    });

    test('returns empty index names when both `ilmExplain` and `stats` are null', () => {
      expect(
        getIndexNames({
          ilmExplain: null,
          ilmPhases,
          isILMAvailable,
          stats: null,
        })
      ).toEqual([]);
    });
  });

  describe('getFieldTypes', () => {
    const expected = [
      {
        field: '@timestamp',
        type: 'date',
      },
      {
        field: 'event.category',
        type: 'keyword',
      },
      {
        field: 'host.name',
        type: 'text',
      },
      {
        field: 'host.name.keyword',
        type: 'keyword',
      },
      {
        field: 'some.field',
        type: 'text',
      },
      {
        field: 'some.field.keyword',
        type: 'keyword',
      },
      {
        field: 'source.ip',
        type: 'text',
      },
      {
        field: 'source.ip.keyword',
        type: 'keyword',
      },
      {
        field: 'source.port',
        type: 'long',
      },
    ];

    test('it flattens the field names and types in the mapping properties', () => {
      expect(getFieldTypes(mockMappingsProperties)).toEqual(expected);
    });

    test('it throws a type error when mappingsProperties is not flatten-able', () => {
      // @ts-expect-error
      const invalidType: Record<string, unknown> = []; // <-- this is an array, NOT a valid Record<string, unknown>

      expect(() => getFieldTypes(invalidType)).toThrowError('Root value is not flatten-able');
    });
  });

  describe('getIsInSameFamily', () => {
    test('it returns false when ecsExpectedType is undefined', () => {
      expect(getIsInSameFamily({ ecsExpectedType: undefined, type: 'keyword' })).toBe(false);
    });

    const expectedFamilyMembers: {
      [key: string]: string[];
    } = {
      constant_keyword: ['keyword', 'wildcard'], // `keyword` and `wildcard` in the same family as `constant_keyword`
      keyword: ['constant_keyword', 'wildcard'],
      match_only_text: ['text'],
      text: ['match_only_text'],
      wildcard: ['keyword', 'constant_keyword'],
    };

    const ecsExpectedTypes = Object.keys(expectedFamilyMembers);

    ecsExpectedTypes.forEach((ecsExpectedType) => {
      const otherMembersOfSameFamily = expectedFamilyMembers[ecsExpectedType];

      otherMembersOfSameFamily.forEach((type) =>
        test(`it returns true for ecsExpectedType '${ecsExpectedType}' when given '${type}', a type in the same family`, () => {
          expect(getIsInSameFamily({ ecsExpectedType, type })).toBe(true);
        })
      );

      test(`it returns false for ecsExpectedType '${ecsExpectedType}' when given 'date', a type NOT in the same family`, () => {
        expect(getIsInSameFamily({ ecsExpectedType, type: 'date' })).toBe(false);
      });
    });
  });

  describe('isMappingCompatible', () => {
    test('it returns true for an exact match', () => {
      expect(isMappingCompatible({ ecsExpectedType: 'keyword', type: 'keyword' })).toBe(true);
    });

    test("it returns false when both types don't exactly match", () => {
      expect(isMappingCompatible({ ecsExpectedType: 'wildcard', type: 'keyword' })).toBe(false);
    });
  });

  describe('getEnrichedFieldMetadata', () => {
    /**
     * The ECS schema
     * https://raw.githubusercontent.com/elastic/ecs/main/generated/ecs/ecs_flat.yml
     * defines a handful of fields that have `allowed_values`. For these
     * fields, the documents in an index should only have specific values.
     *
     * This instance of the type `Record<string, UnallowedValueCount[]>`
     * represents an index that doesn't have any unallowed values, for the
     * specified keys in the map, i.e. `event.category`, `event.kind`, etc.
     *
     * This will be used to test the happy path. Variants of this
     * value will be used to test unhappy paths.
     */
    const noUnallowedValues: Record<string, UnallowedValueCount[]> = {
      'event.category': [],
      'event.kind': [],
      'event.outcome': [],
      'event.type': [],
    };

    /**
     * Represents an index that has unallowed values, for the
     * `event.category` field. The other fields in the collection,
     *  i.e. `event.kind`, don't have any unallowed values.
     *
     * This instance will be used to test paths where a field is
     * NOT ECS complaint, because the index has unallowed values.
     */
    const unallowedValues: Record<string, UnallowedValueCount[]> = {
      'event.category': [
        {
          count: 2,
          fieldName: 'an_invalid_category',
        },
        {
          count: 1,
          fieldName: 'theory',
        },
      ],
      'event.kind': [],
      'event.outcome': [],
      'event.type': [],
    };

    /**
     * This instance of a `FieldType` has the correct mapping for the
     * `event.category` field.
     *
     * This instance will be used to test paths where the index has
     * a valid mapping for the `event.category` field.
     */
    const fieldMetadataCorrectMappingType: FieldType = {
      field: 'event.category',
      type: 'keyword', // <-- this index has the correct mapping type
    };

    /**
     * This `EnrichedFieldMetadata` for the `event.category` field,
     * represents a happy path result, where the index being checked:
     *
     * 1) The `type` of the field in the index, `keyword`, matches the expected
     *    `type` of the `event.category` field, as defined by the `EcsMetadata`
     * 2) The index doesn't have any unallowed values for the `event.category` field
     *
     * Since this is a happy path result, it has the following values:
     * `indexInvalidValues` is an empty array, because the index does not contain any invalid values
     * `isEcsCompliant` is true, because the index has the expected mapping type, and no unallowed values
     */
    const happyPathResultSample: EnrichedFieldMetadata = {
      dashed_name: 'event-category',
      description:
        'This is one of four ECS Categorization Fields, and indicates the second level in the ECS category hierarchy.\n`event.category` represents the "big buckets" of ECS categories. For example, filtering on `event.category:process` yields all events relating to process activity. This field is closely related to `event.type`, which is used as a subcategory.\nThis field is an array. This will allow proper categorization of some events that fall in multiple categories.',
      example: 'authentication',
      flat_name: 'event.category',
      ignore_above: 1024,
      level: 'core',
      name: 'category',
      normalize: ['array'],
      short: 'Event category. The second categorization field in the hierarchy.',
      type: 'keyword',
      indexFieldName: 'event.category',
      indexFieldType: 'keyword', // a valid mapping, because the `type` property from the `ecsMetadata` is also `keyword`
      indexInvalidValues: [], // empty array, because the index does not contain any invalid values
      hasEcsMetadata: true,
      isEcsCompliant: true, // because the index has the expected mapping type, and no unallowed values
      isInSameFamily: false,
    };

    /**
     * Creates expected result matcher based on the happy path result sample. Please, add similar `expect` based assertions to it if anything breaks
     * with an ECS upgrade, instead of hardcoding the values.
     */
    const expectedResult = (extraFields: Record<string, unknown> = {}) =>
      expect.objectContaining({
        ...happyPathResultSample,
        ...extraFields,
        allowed_values: expect.arrayContaining([
          expect.objectContaining({
            description: expect.any(String),
            name: expect.any(String),
            expected_event_types: expect.any(Array),
          }),
        ]),
      });

    test('it returns the happy path result when the index has no mapping conflicts, and no unallowed values', () => {
      expect(
        getEnrichedFieldMetadata({
          ecsMetadata: EcsFlatTyped,
          fieldMetadata: fieldMetadataCorrectMappingType, // no mapping conflicts for `event.category` in this index
          unallowedValues: noUnallowedValues, // no unallowed values for `event.category` in this index
        })
      ).toEqual(expectedResult());
    });

    test('it returns the happy path result when the index has no mapping conflicts, and the unallowedValues map does not contain an entry for the field', () => {
      // create an `unallowedValues` that doesn't have an entry for `event.category`:
      const noEntryForEventCategory: Record<string, UnallowedValueCount[]> = omit(
        'event.category',
        unallowedValues
      );

      expect(
        getEnrichedFieldMetadata({
          ecsMetadata: EcsFlatTyped,
          fieldMetadata: fieldMetadataCorrectMappingType, // no mapping conflicts for `event.category` in this index
          unallowedValues: noEntryForEventCategory, // a lookup in this map for the `event.category` field will return undefined
        })
      ).toEqual(expectedResult());
    });

    test('it returns a result with the expected `indexInvalidValues` and `isEcsCompliant` when the index has no mapping conflict, but it has unallowed values', () => {
      expect(
        getEnrichedFieldMetadata({
          ecsMetadata: EcsFlatTyped,
          fieldMetadata: fieldMetadataCorrectMappingType, // no mapping conflicts for `event.category` in this index
          unallowedValues, // this index has unallowed values for the event.category field
        })
      ).toEqual(
        expectedResult({
          indexInvalidValues: [
            {
              count: 2,
              fieldName: 'an_invalid_category',
            },
            {
              count: 1,
              fieldName: 'theory',
            },
          ],
          isEcsCompliant: false, // because there are unallowed values
        })
      );
    });

    test('it returns a result with the expected `isEcsCompliant` and `isInSameFamily` when the index type does not match ECS, but NO unallowed values', () => {
      const indexFieldType = 'text';

      expect(
        getEnrichedFieldMetadata({
          ecsMetadata: EcsFlatTyped,
          fieldMetadata: {
            field: 'event.category', // `event.category` is a `keyword`, per the ECS spec
            type: indexFieldType, // this index has a mapping of `text` instead
          },
          unallowedValues: noUnallowedValues, // no unallowed values for `event.category` in this index
        })
      ).toEqual(
        expectedResult({
          indexFieldType,
          isEcsCompliant: false, // `keyword` !== `text`
          isInSameFamily: false, // `keyword` and `text` are not in the same family
        })
      );
    });

    test('it returns a result with the expected `isEcsCompliant` and `isInSameFamily` when the mapping is is in the same family', () => {
      const indexFieldType = 'wildcard';

      expect(
        getEnrichedFieldMetadata({
          ecsMetadata: EcsFlatTyped,
          fieldMetadata: {
            field: 'event.category', // `event.category` is a `keyword` per the ECS spec
            type: indexFieldType, // this index has a mapping of `wildcard` instead
          },
          unallowedValues: noUnallowedValues, // no unallowed values for `event.category` in this index
        })
      ).toEqual(
        expectedResult({
          indexFieldType,
          isEcsCompliant: false, // `wildcard` !== `keyword`
          isInSameFamily: true, // `wildcard` and `keyword` are in the same family
        })
      );
    });

    test('it returns a result with the expected `indexInvalidValues`,`isEcsCompliant`, and `isInSameFamily` when the index has BOTH mapping conflicts, and unallowed values', () => {
      const indexFieldType = 'text';

      expect(
        getEnrichedFieldMetadata({
          ecsMetadata: EcsFlatTyped,
          fieldMetadata: {
            field: 'event.category', // `event.category` is a `keyword` per the ECS spec
            type: indexFieldType, // this index has a mapping of `text` instead
          },
          unallowedValues, // this index also has unallowed values for the event.category field
        })
      ).toEqual(
        expectedResult({
          indexFieldType,
          indexInvalidValues: [
            {
              count: 2,
              fieldName: 'an_invalid_category',
            },
            {
              count: 1,
              fieldName: 'theory',
            },
          ],
          isEcsCompliant: false, // because there are BOTH mapping conflicts and unallowed values
          isInSameFamily: false, // `text` and `keyword` are not in the same family
        })
      );
    });

    test('it returns the expected result for a custom field, i.e. a field that does NOT have an entry in `ecsMetadata`', () => {
      const field = 'a_custom_field'; // not defined by ECS
      const indexFieldType = 'keyword';

      expect(
        getEnrichedFieldMetadata({
          ecsMetadata: EcsFlatTyped,
          fieldMetadata: {
            field,
            type: indexFieldType, // no mapping conflict, because ECS doesn't define this field
          },
          unallowedValues: noUnallowedValues, // no unallowed values for `a_custom_field` in this index
        })
      ).toEqual({
        indexFieldName: field,
        indexFieldType,
        indexInvalidValues: [],
        hasEcsMetadata: false,
        isEcsCompliant: false,
        isInSameFamily: false, // custom fields are never in the same family
      });
    });
  });

  describe('getMissingTimestampFieldMetadata', () => {
    test('it returns the expected `EnrichedFieldMetadata`', () => {
      expect(getMissingTimestampFieldMetadata()).toEqual({
        ...EcsFlatTyped['@timestamp'],
        hasEcsMetadata: true,
        indexFieldName: '@timestamp',
        indexFieldType: '-', // the index did NOT define a mapping for @timestamp
        indexInvalidValues: [],
        isEcsCompliant: false, // an index must define the @timestamp mapping
        isInSameFamily: false, // `date` is not a member of any families
      });
    });
  });

  describe('getPartitionedFieldMetadata', () => {
    test('it places all the `EnrichedFieldMetadata` in the expected categories', () => {
      const enrichedFieldMetadata: EnrichedFieldMetadata[] = [
        timestamp,
        eventCategoryWithUnallowedValues,
        hostNameWithTextMapping,
        hostNameKeyword,
        someField,
        someFieldKeyword,
        sourceIpWithTextMapping,
        sourceIpKeyword,
        sourcePort,
      ];
      const expected: PartitionedFieldMetadata = {
        all: [
          timestamp,
          eventCategoryWithUnallowedValues,
          hostNameWithTextMapping,
          hostNameKeyword,
          someField,
          someFieldKeyword,
          sourceIpWithTextMapping,
          sourceIpKeyword,
          sourcePort,
        ],
        ecsCompliant: [timestamp, sourcePort],
        custom: [hostNameKeyword, someField, someFieldKeyword, sourceIpKeyword],
        incompatible: [
          eventCategoryWithUnallowedValues,
          hostNameWithTextMapping,
          sourceIpWithTextMapping,
        ],
        sameFamily: [],
      };

      expect(getPartitionedFieldMetadata(enrichedFieldMetadata)).toEqual(expected);
    });
  });

  describe('getPartitionedFieldMetadataStats', () => {
    test('it returns the expected stats', () => {
      const partitionedFieldMetadata: PartitionedFieldMetadata = {
        all: [
          timestamp,
          eventCategoryWithUnallowedValues,
          hostNameWithTextMapping,
          hostNameKeyword,
          someField,
          someFieldKeyword,
          sourceIpWithTextMapping,
          sourceIpKeyword,
          sourcePort,
        ],
        ecsCompliant: [timestamp, sourcePort],
        custom: [hostNameKeyword, someField, someFieldKeyword, sourceIpKeyword],
        incompatible: [
          eventCategoryWithUnallowedValues,
          hostNameWithTextMapping,
          sourceIpWithTextMapping,
        ],
        sameFamily: [],
      };

      expect(getPartitionedFieldMetadataStats(partitionedFieldMetadata)).toEqual({
        all: 9,
        custom: 4,
        ecsCompliant: 2,
        incompatible: 3,
        sameFamily: 0,
      });
    });
  });

  describe('getDocsCount', () => {
    test('it returns the expected docs count when `stats` contains the `indexName`', () => {
      const indexName = '.ds-packetbeat-8.6.1-2023.02.04-000001';
      const expectedCount = mockStatsPacketbeatIndex[indexName].num_docs;

      expect(
        getDocsCount({
          indexName,
          stats: mockStatsPacketbeatIndex,
        })
      ).toEqual(expectedCount);
    });

    test('it returns zero when `stats` does NOT contain the `indexName`', () => {
      const indexName = 'not-gonna-find-it';

      expect(
        getDocsCount({
          indexName,
          stats: mockStatsPacketbeatIndex,
        })
      ).toEqual(0);
    });

    test('it returns zero when `stats` is null', () => {
      const indexName = '.ds-packetbeat-8.6.1-2023.02.04-000001';

      expect(
        getDocsCount({
          indexName,
          stats: null,
        })
      ).toEqual(0);
    });

    test('it returns the expected total for a green index, where `primaries.docs.count` and `total.docs.count` have different values', () => {
      const indexName = 'auditbeat-custom-index-1';

      expect(
        getDocsCount({
          indexName,
          stats: mockStatsAuditbeatIndex,
        })
      ).toEqual(mockStatsAuditbeatIndex[indexName].num_docs);
    });
  });

  describe('getSizeInBytes', () => {
    test('it returns the expected size when `stats` contains the `indexName`', () => {
      const indexName = '.ds-packetbeat-8.6.1-2023.02.04-000001';
      const expectedCount = mockStatsPacketbeatIndex[indexName].size_in_bytes;

      expect(
        getSizeInBytes({
          indexName,
          stats: mockStatsPacketbeatIndex,
        })
      ).toEqual(expectedCount);
    });

    test('it returns undefined when `stats` does NOT contain the `indexName`', () => {
      const indexName = 'not-gonna-find-it';

      expect(
        getSizeInBytes({
          indexName,
          stats: mockStatsPacketbeatIndex,
        })
      ).toBeUndefined();
    });

    test('it returns undefined when `stats` is null', () => {
      const indexName = '.ds-packetbeat-8.6.1-2023.02.04-000001';

      expect(
        getSizeInBytes({
          indexName,
          stats: null,
        })
      ).toBeUndefined();
    });

    test('it returns the expected size for a green index, where `primaries.store.size_in_bytes` and `total.store.size_in_bytes` have different values', () => {
      const indexName = 'auditbeat-custom-index-1';

      expect(
        getSizeInBytes({
          indexName,
          stats: mockStatsAuditbeatIndex,
        })
      ).toEqual(mockStatsAuditbeatIndex[indexName].size_in_bytes);
    });
  });

  describe('getTotalDocsCount', () => {
    test('it returns the expected total given a subset of index names in the stats', () => {
      const indexName = '.ds-packetbeat-8.5.3-2023.02.04-000001';
      const expectedCount = mockStatsPacketbeatIndex[indexName].num_docs;

      expect(
        getTotalDocsCount({
          indexNames: [indexName],
          stats: mockStatsPacketbeatIndex,
        })
      ).toEqual(expectedCount);
    });

    test('it returns the expected total given all index names in the stats', () => {
      const allIndexNamesInStats = [
        '.ds-packetbeat-8.6.1-2023.02.04-000001',
        '.ds-packetbeat-8.5.3-2023.02.04-000001',
      ];

      expect(
        getTotalDocsCount({
          indexNames: allIndexNamesInStats,
          stats: mockStatsPacketbeatIndex,
        })
      ).toEqual(3258632);
    });

    test('it returns zero given an empty collection of index names', () => {
      expect(
        getTotalDocsCount({
          indexNames: [], // <-- empty
          stats: mockStatsPacketbeatIndex,
        })
      ).toEqual(0);
    });

    test('it returns the expected total for a green index', () => {
      const indexName = 'auditbeat-custom-index-1';
      const expectedCount = mockStatsAuditbeatIndex[indexName].num_docs;

      expect(
        getTotalDocsCount({
          indexNames: [indexName],
          stats: mockStatsAuditbeatIndex,
        })
      ).toEqual(expectedCount);
    });
  });

  describe('getTotalSizeInBytes', () => {
    test('it returns the expected total given a subset of index names in the stats', () => {
      const indexName = '.ds-packetbeat-8.5.3-2023.02.04-000001';
      const expectedCount = mockStatsPacketbeatIndex[indexName].size_in_bytes;

      expect(
        getTotalSizeInBytes({
          indexNames: [indexName],
          stats: mockStatsPacketbeatIndex,
        })
      ).toEqual(expectedCount);
    });

    test('it returns the expected total given all index names in the stats', () => {
      const allIndexNamesInStats = [
        '.ds-packetbeat-8.6.1-2023.02.04-000001',
        '.ds-packetbeat-8.5.3-2023.02.04-000001',
      ];

      expect(
        getTotalSizeInBytes({
          indexNames: allIndexNamesInStats,
          stats: mockStatsPacketbeatIndex,
        })
      ).toEqual(1464758182);
    });

    test('it returns undefined given an empty collection of index names', () => {
      expect(
        getTotalSizeInBytes({
          indexNames: [], // <-- empty
          stats: mockStatsPacketbeatIndex,
        })
      ).toBeUndefined();
    });

    test('it returns undefined if sizeInByte in not an integer', () => {
      const indexName = 'auditbeat-custom-index-1';

      expect(
        getTotalSizeInBytes({
          indexNames: [indexName],
          stats: { [indexName]: { ...mockStatsAuditbeatIndex[indexName], size_in_bytes: null } },
        })
      ).toBeUndefined();
    });

    test('it returns the expected total for an index', () => {
      const indexName = 'auditbeat-custom-index-1';
      const expectedCount = mockStatsAuditbeatIndex[indexName].size_in_bytes;

      expect(
        getTotalSizeInBytes({
          indexNames: [indexName],
          stats: mockStatsAuditbeatIndex,
        })
      ).toEqual(expectedCount);
    });

    test('it returns the expected total for indices', () => {
      const expectedCount = Object.values(mockStatsPacketbeatIndex).reduce(
        (acc, { size_in_bytes: sizeInBytes }) => {
          return acc + (sizeInBytes ?? 0);
        },
        0
      );

      expect(
        getTotalSizeInBytes({
          indexNames: [
            '.ds-packetbeat-8.6.1-2023.02.04-000001',
            '.ds-packetbeat-8.5.3-2023.02.04-000001',
          ],
          stats: mockStatsPacketbeatIndex,
        })
      ).toEqual(expectedCount);
    });
  });

  describe('getIlmPhaseDescription', () => {
    const phases: Array<{
      phase: string;
      expected: string;
    }> = [
      {
        phase: 'hot',
        expected: HOT_DESCRIPTION,
      },
      {
        phase: 'warm',
        expected: WARM_DESCRIPTION,
      },
      {
        phase: 'cold',
        expected: COLD_DESCRIPTION,
      },
      {
        phase: 'frozen',
        expected: FROZEN_DESCRIPTION,
      },
      {
        phase: 'unmanaged',
        expected: UNMANAGED_DESCRIPTION,
      },
      {
        phase: 'something-else',
        expected: ' ',
      },
    ];

    phases.forEach(({ phase, expected }) => {
      test(`it returns ${expected} when phase is ${phase}`, () => {
        expect(getIlmPhaseDescription(phase)).toBe(expected);
      });
    });
  });

  describe('getPatternIlmPhaseDescription', () => {
    const phases: Array<{
      expected: string;
      indices: number;
      pattern: string;
      phase: string;
    }> = [
      {
        expected:
          '1 index matching the .alerts-security.alerts-default pattern is hot. Hot indices are actively being updated and queried.',
        indices: 1,
        pattern: '.alerts-security.alerts-default',
        phase: 'hot',
      },
      {
        expected:
          '2 indices matching the .alerts-security.alerts-default pattern are hot. Hot indices are actively being updated and queried.',
        indices: 2,
        pattern: '.alerts-security.alerts-default',
        phase: 'hot',
      },
      {
        expected:
          '1 index matching the .alerts-security.alerts-default pattern is warm. Warm indices are no longer being updated but are still being queried.',
        indices: 1,
        pattern: '.alerts-security.alerts-default',
        phase: 'warm',
      },
      {
        expected:
          '2 indices matching the .alerts-security.alerts-default pattern are warm. Warm indices are no longer being updated but are still being queried.',
        indices: 2,
        pattern: '.alerts-security.alerts-default',
        phase: 'warm',
      },
      {
        expected:
          '1 index matching the .alerts-security.alerts-default pattern is cold. Cold indices are no longer being updated and are queried infrequently. The information still needs to be searchable, but it’s okay if those queries are slower.',
        indices: 1,
        pattern: '.alerts-security.alerts-default',
        phase: 'cold',
      },
      {
        expected:
          '2 indices matching the .alerts-security.alerts-default pattern are cold. Cold indices are no longer being updated and are queried infrequently. The information still needs to be searchable, but it’s okay if those queries are slower.',
        indices: 2,
        pattern: '.alerts-security.alerts-default',
        phase: 'cold',
      },
      {
        expected:
          "1 index matching the .alerts-security.alerts-default pattern is frozen. Frozen indices are no longer being updated and are queried rarely. The information still needs to be searchable, but it's okay if those queries are extremely slow.",
        indices: 1,
        pattern: '.alerts-security.alerts-default',
        phase: 'frozen',
      },
      {
        expected:
          "2 indices matching the .alerts-security.alerts-default pattern are frozen. Frozen indices are no longer being updated and are queried rarely. The information still needs to be searchable, but it's okay if those queries are extremely slow.",
        indices: 2,
        pattern: '.alerts-security.alerts-default',
        phase: 'frozen',
      },
      {
        expected:
          '1 index matching the .alerts-security.alerts-default pattern is unmanaged by Index Lifecycle Management (ILM)',
        indices: 1,
        pattern: '.alerts-security.alerts-default',
        phase: 'unmanaged',
      },
      {
        expected:
          '2 indices matching the .alerts-security.alerts-default pattern are unmanaged by Index Lifecycle Management (ILM)',
        indices: 2,
        pattern: '.alerts-security.alerts-default',
        phase: 'unmanaged',
      },
      {
        expected: '',
        indices: 1,
        pattern: '.alerts-security.alerts-default',
        phase: 'some-other-phase',
      },
      {
        expected: '',
        indices: 2,
        pattern: '.alerts-security.alerts-default',
        phase: 'some-other-phase',
      },
    ];

    phases.forEach(({ expected, indices, pattern, phase }) => {
      test(`it returns the expected description when indices is ${indices}, pattern is ${pattern}, and phase is ${phase}`, () => {
        expect(getPatternIlmPhaseDescription({ indices, pattern, phase })).toBe(expected);
      });
    });
  });

  describe('getTotalPatternIncompatible', () => {
    test('it returns zero when multiple indices in the results results have a count of zero', () => {
      const results: Record<string, DataQualityCheckResult> = {
        '.ds-packetbeat-8.5.3-2023.02.04-000001': {
          docsCount: 1630289,
          error: null,
          ilmPhase: 'hot',
          incompatible: 0,
          indexName: '.ds-packetbeat-8.5.3-2023.02.04-000001',
          markdownComments: ['foo', 'bar', 'baz'],
          pattern: 'packetbeat-*',
          sameFamily: 0,
          checkedAt: Date.now(),
        },
        '.ds-packetbeat-8.6.1-2023.02.04-000001': {
          docsCount: 1628343,
          error: null,
          ilmPhase: 'hot',
          incompatible: 0,
          indexName: '.ds-packetbeat-8.6.1-2023.02.04-000001',
          markdownComments: ['foo', 'bar', 'baz'],
          pattern: 'packetbeat-*',
          sameFamily: 0,
          checkedAt: Date.now(),
        },
      };

      expect(getTotalPatternIncompatible(results)).toEqual(0);
    });

    test("it returns the expected total when some indices have incompatible fields, but others don't", () => {
      const results: Record<string, DataQualityCheckResult> = {
        '.ds-auditbeat-8.6.1-2023.02.07-000001': {
          docsCount: 18086,
          error: null,
          ilmPhase: 'hot',
          incompatible: 0,
          indexName: '.ds-auditbeat-8.6.1-2023.02.07-000001',
          markdownComments: ['foo', 'bar', 'baz'],
          pattern: 'auditbeat-*',
          sameFamily: 0,
          checkedAt: Date.now(),
        },
        'auditbeat-custom-index-1': {
          docsCount: 4,
          error: null,
          ilmPhase: 'unmanaged',
          incompatible: 3,
          indexName: 'auditbeat-custom-index-1',
          markdownComments: ['foo', 'bar', 'baz'],
          pattern: 'auditbeat-*',
          sameFamily: 0,
          checkedAt: Date.now(),
        },
        'auditbeat-custom-empty-index-1': {
          docsCount: 0,
          error: null,
          ilmPhase: 'unmanaged',
          incompatible: 1,
          indexName: 'auditbeat-custom-empty-index-1',
          markdownComments: ['foo', 'bar', 'baz'],
          pattern: 'auditbeat-*',
          sameFamily: 0,
          checkedAt: Date.now(),
        },
      };

      expect(getTotalPatternIncompatible(results)).toEqual(4);
    });

    test('it returns the expected total when some indices have undefined incompatible counts', () => {
      const results: Record<string, DataQualityCheckResult> = {
        '.ds-auditbeat-8.6.1-2023.02.07-000001': {
          docsCount: 18086,
          error: null,
          ilmPhase: 'hot',
          incompatible: undefined, // <-- this index has an undefined `incompatible`
          indexName: '.ds-auditbeat-8.6.1-2023.02.07-000001',
          markdownComments: ['foo', 'bar', 'baz'],
          pattern: 'auditbeat-*',
          sameFamily: 0,
          checkedAt: Date.now(),
        },
        'auditbeat-custom-index-1': {
          docsCount: 4,
          error: null,
          ilmPhase: 'unmanaged',
          incompatible: 3,
          indexName: 'auditbeat-custom-index-1',
          markdownComments: ['foo', 'bar', 'baz'],
          pattern: 'auditbeat-*',
          sameFamily: 0,
          checkedAt: Date.now(),
        },
        'auditbeat-custom-empty-index-1': {
          docsCount: 0,
          error: null,
          ilmPhase: 'unmanaged',
          incompatible: 1,
          indexName: 'auditbeat-custom-empty-index-1',
          markdownComments: ['foo', 'bar', 'baz'],
          pattern: 'auditbeat-*',
          sameFamily: 0,
          checkedAt: Date.now(),
        },
      };

      expect(getTotalPatternIncompatible(results)).toEqual(4);
    });

    test('it returns zero when `results` is empty', () => {
      expect(getTotalPatternIncompatible({})).toEqual(0);
    });

    test('it returns undefined when `results` is undefined', () => {
      expect(getTotalPatternIncompatible(undefined)).toBeUndefined();
    });
  });

  describe('getTotalPatternIndicesChecked', () => {
    test('it returns zero when `patternRollup` is undefined', () => {
      expect(getTotalPatternIndicesChecked(undefined)).toEqual(0);
    });

    test('it returns zero when `patternRollup` does NOT have any results', () => {
      expect(getTotalPatternIndicesChecked(auditbeatNoResults)).toEqual(0);
    });

    test('it returns the expected total when all indices in `patternRollup` have results', () => {
      expect(getTotalPatternIndicesChecked(auditbeatWithAllResults)).toEqual(3);
    });

    test('it returns the expected total when some indices in `patternRollup` have errors', () => {
      expect(getTotalPatternIndicesChecked(packetbeatWithSomeErrors)).toEqual(1);
    });
  });

  describe('getErrorSummary', () => {
    test('it returns the expected error summary', () => {
      const resultWithError: DataQualityCheckResult = {
        docsCount: 1630289,
        error:
          'Error loading mappings for .ds-packetbeat-8.5.3-2023.02.04-000001: Error: simulated error fetching index .ds-packetbeat-8.5.3-2023.02.04-000001',
        ilmPhase: 'hot',
        incompatible: undefined,
        indexName: '.ds-packetbeat-8.5.3-2023.02.04-000001',
        markdownComments: ['foo', 'bar', 'baz'],
        pattern: 'packetbeat-*',
        sameFamily: 0,
        checkedAt: Date.now(),
      };

      expect(getErrorSummary(resultWithError)).toEqual({
        error:
          'Error loading mappings for .ds-packetbeat-8.5.3-2023.02.04-000001: Error: simulated error fetching index .ds-packetbeat-8.5.3-2023.02.04-000001',
        indexName: '.ds-packetbeat-8.5.3-2023.02.04-000001',
        pattern: 'packetbeat-*',
      });
    });
  });

  describe('getErrorSummariesForRollup', () => {
    test('it returns the expected array of `ErrorSummary` when the `PatternRollup` contains errors', () => {
      expect(getErrorSummariesForRollup(packetbeatWithSomeErrors)).toEqual([
        {
          error:
            'Error loading mappings for .ds-packetbeat-8.5.3-2023.02.04-000001: Error: simulated error fetching index .ds-packetbeat-8.5.3-2023.02.04-000001',
          indexName: '.ds-packetbeat-8.5.3-2023.02.04-000001',
          pattern: 'packetbeat-*',
        },
      ]);
    });

    test('it returns the an empty array of `ErrorSummary` when the `PatternRollup` contains all results, with NO errors', () => {
      expect(getErrorSummariesForRollup(auditbeatWithAllResults)).toEqual([]);
    });

    test('it returns the an empty array of `ErrorSummary` when the `PatternRollup` has NO results', () => {
      expect(getErrorSummariesForRollup(auditbeatNoResults)).toEqual([]);
    });

    test('it returns the an empty array of `ErrorSummary` when the `PatternRollup` is undefined', () => {
      expect(getErrorSummariesForRollup(undefined)).toEqual([]);
    });

    test('it returns BOTH the expected (root) pattern-level error, and an index-level error when `PatternRollup` has both', () => {
      const withPatternLevelError: PatternRollup = {
        ...packetbeatWithSomeErrors,
        error: 'This is a pattern-level error',
      };

      expect(getErrorSummariesForRollup(withPatternLevelError)).toEqual([
        {
          error: 'This is a pattern-level error',
          indexName: null,
          pattern: 'packetbeat-*',
        },
        {
          error:
            'Error loading mappings for .ds-packetbeat-8.5.3-2023.02.04-000001: Error: simulated error fetching index .ds-packetbeat-8.5.3-2023.02.04-000001',
          indexName: '.ds-packetbeat-8.5.3-2023.02.04-000001',
          pattern: 'packetbeat-*',
        },
      ]);
    });

    test('it returns the expected (root) pattern-level error when there are no index-level results', () => {
      const withPatternLevelError: PatternRollup = {
        ...auditbeatNoResults,
        error: 'This is a pattern-level error',
      };

      expect(getErrorSummariesForRollup(withPatternLevelError)).toEqual([
        {
          error: 'This is a pattern-level error',
          indexName: null,
          pattern: 'auditbeat-*',
        },
      ]);
    });
  });

  describe('getErrorSummaries', () => {
    test('it returns an empty array when patternRollups is empty', () => {
      expect(getErrorSummaries({})).toEqual([]);
    });

    test('it returns an empty array when none of the patternRollups have errors', () => {
      expect(
        getErrorSummaries({
          '.alerts-security.alerts-default': alertIndexNoResults,
          'auditbeat-*': auditbeatWithAllResults,
          'packetbeat-*': packetbeatNoResults,
        })
      ).toEqual([]);
    });

    test('it returns the expected array of `ErrorSummary` when some of the `PatternRollup` contain errors', () => {
      expect(
        getErrorSummaries({
          '.alerts-security.alerts-default': alertIndexNoResults,
          'auditbeat-*': auditbeatWithAllResults,
          'packetbeat-*': packetbeatWithSomeErrors, // <-- has errors
        })
      ).toEqual([
        {
          error:
            'Error loading mappings for .ds-packetbeat-8.5.3-2023.02.04-000001: Error: simulated error fetching index .ds-packetbeat-8.5.3-2023.02.04-000001',
          indexName: '.ds-packetbeat-8.5.3-2023.02.04-000001',
          pattern: 'packetbeat-*',
        },
      ]);
    });

    test('it returns the expected array of `ErrorSummary` when there are both pattern-level and index-level errors', () => {
      const withPatternLevelError: PatternRollup = {
        ...auditbeatNoResults,
        error: 'This is a pattern-level error',
      };

      expect(
        getErrorSummaries({
          '.alerts-security.alerts-default': alertIndexNoResults,
          'auditbeat-*': withPatternLevelError, // <-- has pattern-level errors
          'packetbeat-*': packetbeatWithSomeErrors, // <-- has index-level errors
        })
      ).toEqual([
        {
          error: 'This is a pattern-level error',
          indexName: null,
          pattern: 'auditbeat-*',
        },
        {
          error:
            'Error loading mappings for .ds-packetbeat-8.5.3-2023.02.04-000001: Error: simulated error fetching index .ds-packetbeat-8.5.3-2023.02.04-000001',
          indexName: '.ds-packetbeat-8.5.3-2023.02.04-000001',
          pattern: 'packetbeat-*',
        },
      ]);
    });

    test('it returns the expected array of `ErrorSummary` when there are just pattern-level errors', () => {
      const withPatternLevelError: PatternRollup = {
        ...auditbeatNoResults,
        error: 'This is a pattern-level error',
      };

      expect(
        getErrorSummaries({
          '.alerts-security.alerts-default': alertIndexNoResults,
          'auditbeat-*': withPatternLevelError, // <-- has pattern-level errors
          'packetbeat-*': packetbeatNoResults,
        })
      ).toEqual([
        {
          error: 'This is a pattern-level error',
          indexName: null,
          pattern: 'auditbeat-*',
        },
      ]);
    });
  });

  describe('formatStorageResult', () => {
    it('should correctly format the input data into a StorageResult object', () => {
      const inputData: Parameters<typeof formatStorageResult>[number] = {
        result: {
          indexName: 'testIndex',
          pattern: 'testPattern',
          checkedAt: 1627545600000,
          docsCount: 100,
          incompatible: 3,
          sameFamily: 1,
          ilmPhase: 'hot',
          markdownComments: ['test comments'],
          error: null,
        },
        report: {
          batchId: 'testBatch',
          isCheckAll: true,
          sameFamilyFields: ['agent.type'],
          unallowedMappingFields: ['event.category', 'host.name', 'source.ip'],
          unallowedValueFields: ['event.category'],
          sizeInBytes: 5000,
          ecsVersion: '1.0.0',
          indexName: 'testIndex',
          indexId: 'testIndexId',
        },
        partitionedFieldMetadata: mockPartitionedFieldMetadataWithSameFamily,
      };

      const expectedResult: StorageResult = {
        batchId: 'testBatch',
        indexName: 'testIndex',
        indexPattern: 'testPattern',
        isCheckAll: true,
        checkedAt: 1627545600000,
        docsCount: 100,
        totalFieldCount: 10,
        ecsFieldCount: 2,
        customFieldCount: 4,
        incompatibleFieldCount: 3,
        incompatibleFieldMappingItems: [
          {
            fieldName: 'event.category',
            expectedValue: 'keyword',
            actualValue: 'constant_keyword',
            description:
              'This is one of four ECS Categorization Fields, and indicates the second level in the ECS category hierarchy.\n`event.category` represents the "big buckets" of ECS categories. For example, filtering on `event.category:process` yields all events relating to process activity. This field is closely related to `event.type`, which is used as a subcategory.\nThis field is an array. This will allow proper categorization of some events that fall in multiple categories.',
          },
          {
            fieldName: 'host.name',
            expectedValue: 'keyword',
            actualValue: 'text',
            description:
              'Name of the host.\nIt can contain what `hostname` returns on Unix systems, the fully qualified domain name, or a name specified by the user. The sender decides which value to use.',
          },
          {
            fieldName: 'source.ip',
            expectedValue: 'ip',
            actualValue: 'text',
            description: 'IP address of the source (IPv4 or IPv6).',
          },
        ],
        incompatibleFieldValueItems: [
          {
            fieldName: 'event.category',
            expectedValues: [
              'authentication',
              'configuration',
              'database',
              'driver',
              'email',
              'file',
              'host',
              'iam',
              'intrusion_detection',
              'malware',
              'network',
              'package',
              'process',
              'registry',
              'session',
              'threat',
              'vulnerability',
              'web',
            ],
            actualValues: [{ name: 'an_invalid_category', count: 2 }],
            description:
              'This is one of four ECS Categorization Fields, and indicates the second level in the ECS category hierarchy.\n`event.category` represents the "big buckets" of ECS categories. For example, filtering on `event.category:process` yields all events relating to process activity. This field is closely related to `event.type`, which is used as a subcategory.\nThis field is an array. This will allow proper categorization of some events that fall in multiple categories.',
          },
        ],
        sameFamilyFieldCount: 1,
        sameFamilyFields: ['agent.type'],
        sameFamilyFieldItems: [
          {
            fieldName: 'agent.type',
            expectedValue: 'keyword',
            actualValue: 'constant_keyword',
            description:
              'Type of the agent.\nThe agent type always stays the same and should be given by the agent used. In case of Filebeat the agent would always be Filebeat also if two Filebeat instances are run on the same machine.',
          },
        ],
        unallowedMappingFields: ['event.category', 'host.name', 'source.ip'],
        unallowedValueFields: ['event.category'],
        sizeInBytes: 5000,
        ilmPhase: 'hot',
        markdownComments: ['test comments'],
        ecsVersion: '1.0.0',
        indexId: 'testIndexId',
        error: null,
      };

      expect(formatStorageResult(inputData)).toEqual(expectedResult);
    });
  });

  describe('postStorageResult', () => {
    const { fetch } = httpServiceMock.createStartContract();
    const { toasts } = notificationServiceMock.createStartContract();
    beforeEach(() => {
      fetch.mockClear();
    });

    test('it posts the result', async () => {
      const storageResult = { indexName: 'test' } as unknown as StorageResult;
      await postStorageResult({
        storageResult,
        httpFetch: fetch,
        abortController: new AbortController(),
        toasts,
      });

      expect(fetch).toHaveBeenCalledWith(
        '/internal/ecs_data_quality_dashboard/results',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(storageResult),
        })
      );
    });

    test('it throws error', async () => {
      const storageResult = { indexName: 'test' } as unknown as StorageResult;
      fetch.mockRejectedValueOnce('test-error');
      await postStorageResult({
        httpFetch: fetch,
        storageResult,
        abortController: new AbortController(),
        toasts,
      });
      expect(toasts.addError).toHaveBeenCalledWith('test-error', { title: expect.any(String) });
    });
  });

  describe('getStorageResults', () => {
    const { fetch } = httpServiceMock.createStartContract();
    const { toasts } = notificationServiceMock.createStartContract();
    beforeEach(() => {
      fetch.mockClear();
    });

    test('it gets the results', async () => {
      await getStorageResults({
        httpFetch: fetch,
        abortController: new AbortController(),
        pattern: 'auditbeat-*',
        toasts,
      });

      expect(fetch).toHaveBeenCalledWith(
        '/internal/ecs_data_quality_dashboard/results_latest/auditbeat-*',
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should catch error', async () => {
      fetch.mockRejectedValueOnce('test-error');

      const results = await getStorageResults({
        httpFetch: fetch,
        abortController: new AbortController(),
        pattern: 'auditbeat-*',
        toasts,
      });

      expect(toasts.addError).toHaveBeenCalledWith('test-error', { title: expect.any(String) });
      expect(results).toEqual([]);
    });
  });
});
