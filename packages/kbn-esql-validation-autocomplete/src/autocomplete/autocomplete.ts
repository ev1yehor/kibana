/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import uniqBy from 'lodash/uniqBy';
import type {
  AstProviderFn,
  ESQLAstItem,
  ESQLCommand,
  ESQLCommandOption,
  ESQLFunction,
  ESQLLiteral,
  ESQLSingleAstItem,
} from '@kbn/esql-ast';
import { partition } from 'lodash';
import { ESQL_NUMBER_TYPES, compareTypesWithLiterals, isNumericType } from '../shared/esql_types';
import type { EditorContext, SuggestionRawDefinition } from './types';
import {
  lookupColumn,
  getCommandDefinition,
  getCommandOption,
  getFunctionDefinition,
  getLastCharFromTrimmed,
  isArrayType,
  isAssignment,
  isAssignmentComplete,
  isColumnItem,
  isComma,
  isFunctionItem,
  isIncompleteItem,
  isLiteralItem,
  isMathFunction,
  isOptionItem,
  isRestartingExpression,
  isSourceCommand,
  isSettingItem,
  isSourceItem,
  isTimeIntervalItem,
  getAllFunctions,
  isSingleItem,
  nonNullable,
  getColumnExists,
  findPreviousWord,
  noCaseCompare,
} from '../shared/helpers';
import { collectVariables, excludeVariablesFromCurrentCommand } from '../shared/variables';
import type { ESQLPolicy, ESQLRealField, ESQLVariable, ReferenceMaps } from '../validation/types';
import {
  colonCompleteItem,
  commaCompleteItem,
  commandAutocompleteDefinitions,
  getAssignmentDefinitionCompletitionItem,
  getBuiltinCompatibleFunctionDefinition,
  getNextTokenForNot,
  listCompleteItem,
  pipeCompleteItem,
  semiColonCompleteItem,
} from './complete_items';
import {
  buildFieldsDefinitions,
  buildPoliciesDefinitions,
  buildSourcesDefinitions,
  buildNewVarDefinition,
  buildNoPoliciesAvailableDefinition,
  getCompatibleFunctionDefinition,
  buildMatchingFieldsDefinition,
  getCompatibleLiterals,
  buildConstantsDefinitions,
  buildVariablesDefinitions,
  buildOptionDefinition,
  buildSettingDefinitions,
  buildValueDefinitions,
  getDateLiterals,
  buildFieldsDefinitionsWithMetadata,
} from './factories';
import { EDITOR_MARKER, SINGLE_BACKTICK, METADATA_FIELDS } from '../shared/constants';
import { getAstContext, removeMarkerArgFromArgsList } from '../shared/context';
import {
  buildQueryUntilPreviousCommand,
  getFieldsByTypeHelper,
  getPolicyHelper,
  getSourcesHelper,
} from '../shared/resources_helpers';
import { ESQLCallbacks } from '../shared/types';
import {
  getFunctionsToIgnoreForStats,
  getOverlapRange,
  getParamAtPosition,
  getQueryForFields,
  getSourcesFromCommands,
  getSupportedTypesForBinaryOperators,
  isAggFunctionUsedAlready,
  removeQuoteForSuggestedSources,
} from './helper';
import { FunctionParameter, FunctionReturnType, SupportedDataType } from '../definitions/types';

type GetSourceFn = () => Promise<SuggestionRawDefinition[]>;
type GetDataStreamsForIntegrationFn = (
  sourceName: string
) => Promise<Array<{ name: string; title?: string }> | undefined>;
type GetFieldsByTypeFn = (
  type: string | string[],
  ignored?: string[],
  options?: { advanceCursorAndOpenSuggestions?: boolean; addComma?: boolean }
) => Promise<SuggestionRawDefinition[]>;
type GetFieldsMapFn = () => Promise<Map<string, ESQLRealField>>;
type GetPoliciesFn = () => Promise<SuggestionRawDefinition[]>;
type GetPolicyMetadataFn = (name: string) => Promise<ESQLPolicy | undefined>;

function hasSameArgBothSides(assignFn: ESQLFunction) {
  if (assignFn.name === '=' && isColumnItem(assignFn.args[0]) && assignFn.args[1]) {
    const assignValue = assignFn.args[1];
    if (Array.isArray(assignValue) && isColumnItem(assignValue[0])) {
      return assignFn.args[0].name === assignValue[0].name;
    }
  }
}

function appendEnrichFields(
  fieldsMap: Map<string, ESQLRealField>,
  policyMetadata: ESQLPolicy | undefined
) {
  if (!policyMetadata) {
    return fieldsMap;
  }
  // @TODO: improve this
  const newMap: Map<string, ESQLRealField> = new Map(fieldsMap);
  for (const field of policyMetadata.enrichFields) {
    newMap.set(field, { name: field, type: 'double' });
  }
  return newMap;
}

function getFinalSuggestions({ comma }: { comma?: boolean } = { comma: true }) {
  const finalSuggestions = [pipeCompleteItem];
  if (comma) {
    finalSuggestions.push(commaCompleteItem);
  }
  return finalSuggestions;
}

/**
 * This function count the number of unclosed brackets in order to
 * locally fix the queryString to generate a valid AST
 * A known limitation of this is that is not aware of commas "," or pipes "|"
 * so it is not yet helpful on a multiple commands errors (a workaround it to pass each command here...)
 * @param bracketType
 * @param text
 * @returns
 */
function countBracketsUnclosed(bracketType: '(' | '[' | '"' | '"""', text: string) {
  const stack = [];
  const closingBrackets = { '(': ')', '[': ']', '"': '"', '"""': '"""' };
  for (let i = 0; i < text.length; i++) {
    const substr = text.substring(i, i + bracketType.length);
    if (substr === closingBrackets[bracketType] && stack.length) {
      stack.pop();
    } else if (substr === bracketType) {
      stack.push(bracketType);
    }
  }
  return stack.length;
}

/**
 * This function attempts to correct the syntax of a partial query to make it valid.
 *
 * This is important because a syntactically-invalid query will not generate a good AST.
 *
 * @param _query
 * @param context
 * @returns
 */
function correctQuerySyntax(_query: string, context: EditorContext) {
  let query = _query;
  // check if all brackets are closed, otherwise close them
  const unclosedRoundBrackets = countBracketsUnclosed('(', query);
  const unclosedSquaredBrackets = countBracketsUnclosed('[', query);
  const unclosedQuotes = countBracketsUnclosed('"', query);
  const unclosedTripleQuotes = countBracketsUnclosed('"""', query);
  // if it's a comma by the user or a forced trigger by a function argument suggestion
  // add a marker to make the expression still valid
  const charThatNeedMarkers = [',', ':'];
  if (
    (context.triggerCharacter && charThatNeedMarkers.includes(context.triggerCharacter)) ||
    // monaco.editor.CompletionTriggerKind['Invoke'] === 0
    (context.triggerKind === 0 && unclosedRoundBrackets === 0) ||
    (context.triggerCharacter === ' ' && isMathFunction(query, query.length)) ||
    isComma(query.trimEnd()[query.trimEnd().length - 1])
  ) {
    query += EDITOR_MARKER;
  }

  // if there are unclosed brackets, close them
  if (unclosedRoundBrackets || unclosedSquaredBrackets || unclosedQuotes) {
    for (const [char, count] of [
      ['"""', unclosedTripleQuotes],
      ['"', unclosedQuotes],
      [')', unclosedRoundBrackets],
      [']', unclosedSquaredBrackets],
    ]) {
      if (count) {
        // inject the closing brackets
        query += Array(count).fill(char).join('');
      }
    }
  }

  return query;
}

export async function suggest(
  fullText: string,
  offset: number,
  context: EditorContext,
  astProvider: AstProviderFn,
  resourceRetriever?: ESQLCallbacks
): Promise<SuggestionRawDefinition[]> {
  const innerText = fullText.substring(0, offset);

  const correctedQuery = correctQuerySyntax(innerText, context);

  const { ast } = await astProvider(correctedQuery);

  const astContext = getAstContext(innerText, ast, offset);
  // build the correct query to fetch the list of fields
  const queryForFields = getQueryForFields(
    buildQueryUntilPreviousCommand(ast, correctedQuery),
    ast
  );
  const { getFieldsByType, getFieldsMap } = getFieldsByTypeRetriever(
    queryForFields,
    resourceRetriever
  );
  const getSources = getSourcesRetriever(resourceRetriever);
  const getDatastreamsForIntegration = getDatastreamsForIntegrationRetriever(resourceRetriever);
  const { getPolicies, getPolicyMetadata } = getPolicyRetriever(resourceRetriever);

  if (astContext.type === 'newCommand') {
    // propose main commands here
    // filter source commands if already defined
    const suggestions = commandAutocompleteDefinitions;
    if (!ast.length) {
      return suggestions.filter(isSourceCommand);
    }

    return suggestions.filter((def) => !isSourceCommand(def));
  }

  if (astContext.type === 'expression') {
    // suggest next possible argument, or option
    // otherwise a variable
    return getExpressionSuggestionsByType(
      innerText,
      ast,
      astContext,
      getSources,
      getDatastreamsForIntegration,
      getFieldsByType,
      getFieldsMap,
      getPolicies,
      getPolicyMetadata
    );
  }
  if (astContext.type === 'setting') {
    return getSettingArgsSuggestions(
      innerText,
      ast,
      astContext,
      getFieldsByType,
      getFieldsMap,
      getPolicyMetadata
    );
  }
  if (astContext.type === 'option') {
    // need this wrap/unwrap thing to make TS happy
    const { option, ...rest } = astContext;
    if (option && isOptionItem(option)) {
      return getOptionArgsSuggestions(
        innerText,
        ast,
        { option, ...rest },
        getFieldsByType,
        getFieldsMap,
        getPolicyMetadata
      );
    }
  }
  if (astContext.type === 'function') {
    return getFunctionArgsSuggestions(
      innerText,
      ast,
      astContext,
      getFieldsByType,
      getFieldsMap,
      getPolicyMetadata
    );
  }
  if (astContext.type === 'list') {
    return getListArgsSuggestions(
      innerText,
      ast,
      astContext,
      getFieldsByType,
      getFieldsMap,
      getPolicyMetadata
    );
  }
  return [];
}

function getFieldsByTypeRetriever(
  queryString: string,
  resourceRetriever?: ESQLCallbacks
): { getFieldsByType: GetFieldsByTypeFn; getFieldsMap: GetFieldsMapFn } {
  const helpers = getFieldsByTypeHelper(queryString, resourceRetriever);
  return {
    getFieldsByType: async (
      expectedType: string | string[] = 'any',
      ignored: string[] = [],
      options
    ) => {
      const fields = await helpers.getFieldsByType(expectedType, ignored);
      return buildFieldsDefinitionsWithMetadata(fields, options);
    },
    getFieldsMap: helpers.getFieldsMap,
  };
}

function getPolicyRetriever(resourceRetriever?: ESQLCallbacks) {
  const helpers = getPolicyHelper(resourceRetriever);
  return {
    getPolicies: async () => {
      const policies = await helpers.getPolicies();
      return buildPoliciesDefinitions(policies);
    },
    getPolicyMetadata: helpers.getPolicyMetadata,
  };
}

function getSourcesRetriever(resourceRetriever?: ESQLCallbacks) {
  const helper = getSourcesHelper(resourceRetriever);
  return async () => {
    const list = (await helper()) || [];
    // hide indexes that start with .
    return buildSourcesDefinitions(
      list
        .filter(({ hidden }) => !hidden)
        .map(({ name, dataStreams, title, type }) => {
          return { name, isIntegration: Boolean(dataStreams && dataStreams.length), title, type };
        })
    );
  };
}

function getDatastreamsForIntegrationRetriever(
  resourceRetriever?: ESQLCallbacks
): GetDataStreamsForIntegrationFn {
  const helper = getSourcesHelper(resourceRetriever);
  return async (sourceName: string) => {
    const list = (await helper()) || [];
    return list.find(({ name }) => name === sourceName)?.dataStreams;
  };
}

function findNewVariable(variables: Map<string, ESQLVariable[]>) {
  let autoGeneratedVariableCounter = 0;
  let name = `var${autoGeneratedVariableCounter++}`;
  while (variables.has(name)) {
    name = `var${autoGeneratedVariableCounter++}`;
  }
  return name;
}

function workoutBuiltinOptions(
  nodeArg: ESQLAstItem,
  references: Pick<ReferenceMaps, 'fields' | 'variables'>
): { skipAssign: boolean } {
  // skip assign operator if it's a function or an existing field to avoid promoting shadowing
  return {
    skipAssign: Boolean(!isColumnItem(nodeArg) || lookupColumn(nodeArg, references)),
  };
}

function areCurrentArgsValid(
  command: ESQLCommand,
  node: ESQLAstItem,
  references: Pick<ReferenceMaps, 'fields' | 'variables'>
) {
  // unfortunately here we need to bake some command-specific logic
  if (command.name === 'stats') {
    if (node) {
      // consider the following expressions not complete yet
      // ... | stats a
      // ... | stats a =
      if (isColumnItem(node) || (isAssignment(node) && !isAssignmentComplete(node))) {
        return false;
      }
    }
  }
  if (command.name === 'eval') {
    if (node) {
      if (isFunctionItem(node)) {
        if (isAssignment(node)) {
          return isAssignmentComplete(node);
        } else {
          return isFunctionArgComplete(node, references).complete;
        }
      }
    }
  }
  if (command.name === 'where') {
    if (node) {
      if (
        isColumnItem(node) ||
        (isFunctionItem(node) && !isFunctionArgComplete(node, references).complete)
      ) {
        return false;
      } else {
        return (
          extractFinalTypeFromArg(node, references) ===
          getCommandDefinition(command.name).signature.params[0].type
        );
      }
    }
  }
  if (command.name === 'rename') {
    if (node) {
      if (isColumnItem(node)) {
        return true;
      }
    }
  }
  return true;
}

function extractFinalTypeFromArg(
  arg: ESQLAstItem,
  references: Pick<ReferenceMaps, 'fields' | 'variables'>
):
  | ESQLLiteral['literalType']
  | SupportedDataType
  | FunctionReturnType
  | 'timeInterval'
  | string // @TODO remove this
  | undefined {
  if (Array.isArray(arg)) {
    return extractFinalTypeFromArg(arg[0], references);
  }
  if (isColumnItem(arg) || isLiteralItem(arg)) {
    if (isLiteralItem(arg)) {
      return arg.literalType;
    }
    if (isColumnItem(arg)) {
      const hit = lookupColumn(arg, references);
      if (hit) {
        return hit.type;
      }
    }
  }
  if (isTimeIntervalItem(arg)) {
    return arg.type;
  }
  if (isFunctionItem(arg)) {
    const fnDef = getFunctionDefinition(arg.name);
    if (fnDef) {
      // @TODO: improve this to better filter down the correct return type based on existing arguments
      // just mind that this can be highly recursive...
      return fnDef.signatures[0].returnType;
    }
  }
}

// @TODO: refactor this to be shared with validation
function isFunctionArgComplete(
  arg: ESQLFunction,
  references: Pick<ReferenceMaps, 'fields' | 'variables'>
) {
  const fnDefinition = getFunctionDefinition(arg.name);
  if (!fnDefinition) {
    return { complete: false };
  }
  const cleanedArgs = removeMarkerArgFromArgsList(arg)!.args;
  const argLengthCheck = fnDefinition.signatures.some((def) => {
    if (def.minParams && cleanedArgs.length >= def.minParams) {
      return true;
    }
    if (cleanedArgs.length === def.params.length) {
      return true;
    }
    return cleanedArgs.length >= def.params.filter(({ optional }) => !optional).length;
  });
  if (!argLengthCheck) {
    return { complete: false, reason: 'fewArgs' };
  }
  if (fnDefinition.name === 'in' && Array.isArray(arg.args[1]) && !arg.args[1].length) {
    return { complete: false, reason: 'fewArgs' };
  }
  const hasCorrectTypes = fnDefinition.signatures.some((def) => {
    return arg.args.every((a, index) => {
      return def.params[index].type === extractFinalTypeFromArg(a, references);
    });
  });
  if (!hasCorrectTypes) {
    return { complete: false, reason: 'wrongTypes' };
  }
  return { complete: true };
}

function extractArgMeta(
  commandOrOption: ESQLCommand | ESQLCommandOption,
  node: ESQLSingleAstItem | undefined
) {
  let argIndex = commandOrOption.args.length;
  const prevIndex = Math.max(argIndex - 1, 0);
  const lastArg = removeMarkerArgFromArgsList(commandOrOption)!.args[prevIndex];
  if (isIncompleteItem(lastArg)) {
    argIndex = prevIndex;
  }

  // if a node is not specified use the lastArg
  // mind to give priority to node as lastArg might be a function root
  // => "a > b and c == d" gets translated into and( gt(a, b) , eq(c, d) ) => hence "and" is lastArg
  const nodeArg = node || lastArg;

  return { argIndex, prevIndex, lastArg, nodeArg };
}

async function getExpressionSuggestionsByType(
  innerText: string,
  commands: ESQLCommand[],
  {
    command,
    option,
    node,
  }: {
    command: ESQLCommand;
    option: ESQLCommandOption | undefined;
    node: ESQLSingleAstItem | undefined;
  },
  getSources: GetSourceFn,
  getDatastreamsForIntegration: GetDataStreamsForIntegrationFn,
  getFieldsByType: GetFieldsByTypeFn,
  getFieldsMap: GetFieldsMapFn,
  getPolicies: GetPoliciesFn,
  getPolicyMetadata: GetPolicyMetadataFn
) {
  const commandDef = getCommandDefinition(command.name);
  const { argIndex, prevIndex, lastArg, nodeArg } = extractArgMeta(command, node);

  // TODO - this is a workaround because it was too difficult to handle this case in a generic way :(
  if (commandDef.name === 'from' && node && isSourceItem(node) && /\s/.test(node.name)) {
    // FROM " <suggest>"
    return [];
  }

  // A new expression is considered either
  // * just after a command name => i.e. ... | STATS <here>
  // * or after a comma => i.e. STATS fieldA, <here>
  const isNewExpression =
    isRestartingExpression(innerText) ||
    (argIndex === 0 && (!isFunctionItem(nodeArg) || !nodeArg?.args.length));

  // the not function is a special operator that can be used in different ways,
  // and not all these are mapped within the AST data structure: in particular
  // <COMMAND> <field> NOT <here>
  // is an incomplete statement and it results in a missing AST node, so we need to detect
  // from the query string itself
  const endsWithNot =
    / not$/i.test(innerText.trimEnd()) &&
    !command.args.some((arg) => isFunctionItem(arg) && arg.name === 'not');

  // early exit in case of a missing function
  if (isFunctionItem(lastArg) && !getFunctionDefinition(lastArg.name)) {
    return [];
  }

  // Are options already declared? This is useful to suggest only new ones
  const optionsAlreadyDeclared = (
    command.args.filter((arg) => isOptionItem(arg)) as ESQLCommandOption[]
  ).map(({ name }) => ({
    name,
    index: commandDef.options.findIndex(({ name: defName }) => defName === name),
  }));
  const optionsAvailable = commandDef.options.filter(({ name }, index) => {
    const optArg = optionsAlreadyDeclared.find(({ name: optionName }) => optionName === name);
    return (!optArg && !optionsAlreadyDeclared.length) || (optArg && index > optArg.index);
  });
  // get the next definition for the given command
  let argDef = commandDef.signature.params[argIndex];
  // tune it for the variadic case
  if (!argDef) {
    // this is the case of a comma argument
    if (commandDef.signature.multipleParams) {
      if (isNewExpression || (isAssignment(lastArg) && !isAssignmentComplete(lastArg))) {
        // i.e. ... | <COMMAND> a, <here>
        // i.e. ... | <COMMAND> a = ..., b = <here>
        argDef = commandDef.signature.params[0];
      }
    }

    // this is the case where there's an argument, but it's of the wrong type
    // i.e. ... | WHERE numberField <here> (WHERE wants a boolean expression!)
    // i.e. ... | STATS numberfield <here> (STATS wants a function expression!)
    if (!isNewExpression && nodeArg && !Array.isArray(nodeArg)) {
      const prevArg = commandDef.signature.params[prevIndex];
      // in some cases we do not want to go back as the command only accepts a literal
      // i.e. LIMIT 5 <suggest> -> that's it, so no argDef should be assigned

      // make an exception for STATS (STATS is the only command who accept a function type as arg)
      if (
        prevArg &&
        (prevArg.type === 'function' || (!Array.isArray(nodeArg) && prevArg.type !== nodeArg.type))
      ) {
        if (!isLiteralItem(nodeArg) || !prevArg.constantOnly) {
          argDef = prevArg;
        }
      }
    }
  }

  // collect all fields + variables to suggest
  const fieldsMap: Map<string, ESQLRealField> = await (argDef ? getFieldsMap() : new Map());
  const anyVariables = collectVariables(commands, fieldsMap, innerText);

  // enrich with assignment has some special rules who are handled somewhere else
  const canHaveAssignments = ['eval', 'stats', 'row'].includes(command.name);

  const references = { fields: fieldsMap, variables: anyVariables };

  const suggestions: SuggestionRawDefinition[] = [];

  // in this flow there's a clear plan here from argument definitions so try to follow it
  if (argDef) {
    if (argDef.type === 'column' || argDef.type === 'any' || argDef.type === 'function') {
      if (isNewExpression && canHaveAssignments) {
        if (endsWithNot) {
          // i.e.
          // ... | ROW field NOT <suggest>
          // ... | EVAL field NOT <suggest>
          // there's not way to know the type of the field here, so suggest anything
          suggestions.push(...getNextTokenForNot(command.name, option?.name, 'any'));
        } else {
          // i.e.
          // ... | ROW <suggest>
          // ... | STATS <suggest>
          // ... | STATS ..., <suggest>
          // ... | EVAL <suggest>
          // ... | EVAL ..., <suggest>
          suggestions.push(buildNewVarDefinition(findNewVariable(anyVariables)));
        }
      }
    }
    // Suggest fields or variables
    if (argDef.type === 'column' || argDef.type === 'any') {
      if ((!nodeArg || isNewExpression) && !endsWithNot) {
        const fieldSuggestions = await getFieldsOrFunctionsSuggestions(
          argDef.innerTypes || ['any'],
          command.name,
          option?.name,
          getFieldsByType,
          {
            // TODO instead of relying on canHaveAssignments and other command name checks
            // we should have a more generic way to determine if a command can have functions.
            // I think it comes down to the definition of 'column' since 'any' should always
            // include functions.
            functions: canHaveAssignments || command.name === 'sort',
            fields: !argDef.constantOnly,
            variables: anyVariables,
            literals: argDef.constantOnly,
          },
          {
            ignoreFields: isNewExpression
              ? command.args.filter(isColumnItem).map(({ name }) => name)
              : [],
          }
        );

        /**
         * @TODO — this string manipulation is crude and can't support all cases
         * Checking for a partial word and computing the replacement range should
         * really be done using the AST node, but we'll have to refactor further upstream
         * to make that available. This is a quick fix to support the most common case.
         */
        const words = innerText.split(/\s+/);
        const lastWord = words[words.length - 1];
        if (lastWord !== '') {
          // ... | <COMMAND> <word><suggest>
          suggestions.push(
            ...fieldSuggestions.map((suggestion) => ({
              ...suggestion,
              rangeToReplace: {
                start: innerText.length - lastWord.length + 1,
                end: innerText.length,
              },
            }))
          );
        } else {
          // ... | <COMMAND> <suggest>
          suggestions.push(...fieldSuggestions);
        }
      }
    }
    if (argDef.type === 'function' || argDef.type === 'any') {
      if (isColumnItem(nodeArg)) {
        // ... | STATS a <suggest>
        // ... | EVAL a <suggest>
        const nodeArgType = extractFinalTypeFromArg(nodeArg, references);
        if (nodeArgType) {
          suggestions.push(
            ...getBuiltinCompatibleFunctionDefinition(
              command.name,
              undefined,
              nodeArgType,
              undefined,
              workoutBuiltinOptions(nodeArg, references)
            )
          );
        } else {
          suggestions.push(getAssignmentDefinitionCompletitionItem());
        }
      }
      if (
        (isNewExpression && !endsWithNot) ||
        (isAssignment(nodeArg) && !isAssignmentComplete(nodeArg))
      ) {
        // ... | STATS a = <suggest>
        // ... | EVAL a = <suggest>
        // ... | STATS a = ..., <suggest>
        // ... | EVAL a = ..., <suggest>
        // ... | STATS a = ..., b = <suggest>
        // ... | EVAL a = ..., b = <suggest>
        suggestions.push(
          ...(await getFieldsOrFunctionsSuggestions(
            ['any'],
            command.name,
            option?.name,
            getFieldsByType,
            {
              functions: true,
              fields: false,
              variables: nodeArg ? undefined : anyVariables,
              literals: argDef.constantOnly,
            }
          ))
        );
        if (['show', 'meta'].includes(command.name)) {
          suggestions.push(
            ...getBuiltinCompatibleFunctionDefinition(command.name, undefined, 'any')
          );
        }
      }
    }

    if (argDef.type === 'any') {
      // ... | EVAL var = field <suggest>
      // ... | EVAL var = fn(field) <suggest>
      // make sure we're still in the same assignment context and there's no comma (newExpression ensures that)
      if (!isNewExpression) {
        if (isAssignment(nodeArg) && isAssignmentComplete(nodeArg)) {
          const [rightArg] = nodeArg.args[1] as [ESQLSingleAstItem];
          const nodeArgType = extractFinalTypeFromArg(rightArg, references);
          suggestions.push(
            ...getBuiltinCompatibleFunctionDefinition(
              command.name,
              undefined,
              nodeArgType || 'any',
              undefined,
              workoutBuiltinOptions(rightArg, references)
            )
          );
          if (isNumericType(nodeArgType) && isLiteralItem(rightArg)) {
            // ... EVAL var = 1 <suggest>
            suggestions.push(...getCompatibleLiterals(command.name, ['time_literal_unit']));
          }
          if (isFunctionItem(rightArg)) {
            if (rightArg.args.some(isTimeIntervalItem)) {
              const lastFnArg = rightArg.args[rightArg.args.length - 1];
              const lastFnArgType = extractFinalTypeFromArg(lastFnArg, references);
              if (isNumericType(lastFnArgType) && isLiteralItem(lastFnArg))
                // ... EVAL var = 1 year + 2 <suggest>
                suggestions.push(...getCompatibleLiterals(command.name, ['time_literal_unit']));
            }
          }
        } else {
          if (isFunctionItem(nodeArg)) {
            if (nodeArg.name === 'not') {
              suggestions.push(
                ...(await getFieldsOrFunctionsSuggestions(
                  ['boolean'],
                  command.name,
                  option?.name,
                  getFieldsByType,
                  {
                    functions: true,
                    fields: true,
                    variables: anyVariables,
                  }
                ))
              );
            } else {
              const nodeArgType = extractFinalTypeFromArg(nodeArg, references);
              suggestions.push(
                ...(await getBuiltinFunctionNextArgument(
                  innerText,
                  command,
                  option,
                  argDef,
                  nodeArg,
                  (nodeArgType as string) || 'any',
                  references,
                  getFieldsByType
                ))
              );
              if (nodeArg.args.some(isTimeIntervalItem)) {
                const lastFnArg = nodeArg.args[nodeArg.args.length - 1];
                const lastFnArgType = extractFinalTypeFromArg(lastFnArg, references);
                if (isNumericType(lastFnArgType) && isLiteralItem(lastFnArg))
                  // ... EVAL var = 1 year + 2 <suggest>
                  suggestions.push(...getCompatibleLiterals(command.name, ['time_literal_unit']));
              }
            }
          }
        }
      }
    }

    // if the definition includes a list of constants, suggest them
    if (argDef.values) {
      // ... | <COMMAND> ... <suggest enums>
      suggestions.push(
        ...buildConstantsDefinitions(argDef.values, undefined, undefined, {
          advanceCursorAndOpenSuggestions: true,
        })
      );
    }
    // If the type is specified try to dig deeper in the definition to suggest the best candidate
    if (
      ['string', 'text', 'keyword', 'boolean', ...ESQL_NUMBER_TYPES].includes(argDef.type) &&
      !argDef.values
    ) {
      // it can be just literal values (i.e. "string")
      if (argDef.constantOnly) {
        // ... | <COMMAND> ... <suggest>
        suggestions.push(...getCompatibleLiterals(command.name, [argDef.type], [argDef.name]));
      } else {
        // or it can be anything else as long as it is of the right type and the end (i.e. column or function)
        if (!nodeArg) {
          if (endsWithNot) {
            // i.e.
            // ... | WHERE field NOT <suggest>
            // there's not way to know the type of the field here, so suggest anything
            suggestions.push(...getNextTokenForNot(command.name, option?.name, 'any'));
          } else {
            // ... | <COMMAND> <suggest>
            // In this case start suggesting something not strictly based on type
            suggestions.push(
              ...(await getFieldsByType('any', [], { advanceCursorAndOpenSuggestions: true })),
              ...(await getFieldsOrFunctionsSuggestions(
                ['any'],
                command.name,
                option?.name,
                getFieldsByType,
                {
                  functions: true,
                  fields: false,
                  variables: anyVariables,
                }
              ))
            );
          }
        } else {
          // if something is already present, leverage its type to suggest something in context
          const nodeArgType = extractFinalTypeFromArg(nodeArg, references);
          // These cases can happen here, so need to identify each and provide the right suggestion
          // i.e. ... | <COMMAND> field <suggest>
          // i.e. ... | <COMMAND> field + <suggest>
          // i.e. ... | <COMMAND> field >= <suggest>
          // i.e. ... | <COMMAND> field > 0 <suggest>
          // i.e. ... | <COMMAND> field + otherN <suggest>
          // "FROM a | WHERE doubleField IS NOT N"
          if (nodeArgType) {
            if (isFunctionItem(nodeArg)) {
              if (nodeArg.name === 'not') {
                suggestions.push(
                  ...(await getFieldsOrFunctionsSuggestions(
                    ['boolean'],
                    command.name,
                    option?.name,
                    getFieldsByType,
                    {
                      functions: true,
                      fields: true,
                      variables: anyVariables,
                    }
                  ))
                );
              } else {
                suggestions.push(
                  ...(await getBuiltinFunctionNextArgument(
                    innerText,
                    command,
                    option,
                    argDef,
                    nodeArg,
                    nodeArgType as string,
                    references,
                    getFieldsByType
                  ))
                );
              }
            } else {
              // i.e. ... | <COMMAND> field <suggest>
              suggestions.push(
                ...getBuiltinCompatibleFunctionDefinition(
                  command.name,
                  undefined,
                  nodeArgType,
                  undefined,
                  workoutBuiltinOptions(nodeArg, references)
                )
              );
            }
          }
        }
      }
    }
    if (argDef.type === 'source') {
      if (argDef.innerTypes?.includes('policy')) {
        // ... | ENRICH <suggest>
        const policies = await getPolicies();
        suggestions.push(...(policies.length ? policies : [buildNoPoliciesAvailableDefinition()]));
      } else {
        const index = getSourcesFromCommands(commands, 'index');
        const canRemoveQuote = isNewExpression && innerText.includes('"');
        // Function to add suggestions based on canRemoveQuote
        const addSuggestionsBasedOnQuote = async (definitions: SuggestionRawDefinition[]) => {
          suggestions.push(
            ...(canRemoveQuote ? removeQuoteForSuggestedSources(definitions) : definitions)
          );
        };

        if (index && index.text && index.text !== EDITOR_MARKER) {
          const source = index.text.replace(EDITOR_MARKER, '');
          const dataStreams = await getDatastreamsForIntegration(source);

          if (dataStreams) {
            // Integration name, suggest the datastreams
            await addSuggestionsBasedOnQuote(
              buildSourcesDefinitions(
                dataStreams.map(({ name }) => ({ name, isIntegration: false }))
              )
            );
          } else {
            // Not an integration, just a partial source name
            await addSuggestionsBasedOnQuote(await getSources());
          }
        } else {
          // FROM <suggest> or no index/text
          await addSuggestionsBasedOnQuote(await getSources());
        }
      }
    }
  }

  const nonOptionArgs = command.args.filter(
    (arg) => !isOptionItem(arg) && !isSettingItem(arg) && !Array.isArray(arg) && !arg.incomplete
  );
  // Perform some checks on mandatory arguments
  const mandatoryArgsAlreadyPresent =
    (commandDef.signature.multipleParams && nonOptionArgs.length > 1) ||
    nonOptionArgs.length >=
      commandDef.signature.params.filter(({ optional }) => !optional).length ||
    argDef?.type === 'function';

  // check if declared args are fully valid for the given command
  const currentArgsAreValidForCommand = areCurrentArgsValid(command, nodeArg, references);

  // latest suggestions: options and final ones
  if (
    (!isNewExpression && mandatoryArgsAlreadyPresent && currentArgsAreValidForCommand) ||
    optionsAlreadyDeclared.length
  ) {
    // suggest some command options
    if (optionsAvailable.length) {
      suggestions.push(
        ...optionsAvailable.map((opt) => buildOptionDefinition(opt, command.name === 'dissect'))
      );
    }

    if (!optionsAvailable.length || optionsAvailable.every(({ optional }) => optional)) {
      const shouldPushItDown = command.name === 'eval' && !command.args.some(isFunctionItem);
      // now suggest pipe or comma
      const finalSuggestions = getFinalSuggestions({
        comma:
          commandDef.signature.multipleParams &&
          optionsAvailable.length === commandDef.options.length,
      }).map(({ sortText, ...rest }) => ({
        ...rest,
        sortText: shouldPushItDown ? `Z${sortText}` : sortText,
      }));
      suggestions.push(...finalSuggestions);
    }
  }
  // Due to some logic overlapping functions can be repeated
  // so dedupe here based on text string (it can differ from name)
  return uniqBy(suggestions, (suggestion) => suggestion.text);
}

async function getBuiltinFunctionNextArgument(
  queryText: string,
  command: ESQLCommand,
  option: ESQLCommandOption | undefined,
  argDef: { type: string },
  nodeArg: ESQLFunction,
  nodeArgType: string,
  references: Pick<ReferenceMaps, 'fields' | 'variables'>,
  getFieldsByType: GetFieldsByTypeFn
) {
  const suggestions = [];
  const isFnComplete = isFunctionArgComplete(nodeArg, references);

  if (isFnComplete.complete) {
    // i.e. ... | <COMMAND> field > 0 <suggest>
    // i.e. ... | <COMMAND> field + otherN <suggest>
    suggestions.push(
      ...getBuiltinCompatibleFunctionDefinition(
        command.name,
        option?.name,
        nodeArgType || 'any',
        undefined,
        workoutBuiltinOptions(nodeArg, references)
      )
    );
  } else {
    // i.e. ... | <COMMAND> field >= <suggest>
    // i.e. ... | <COMMAND> field + <suggest>
    // i.e. ... | <COMMAND> field and <suggest>

    // Because it's an incomplete function, need to extract the type of the current argument
    // and suggest the next argument based on types

    // pick the last arg and check its type to verify whether is incomplete for the given function
    const cleanedArgs = removeMarkerArgFromArgsList(nodeArg)!.args;
    const nestedType = extractFinalTypeFromArg(nodeArg.args[cleanedArgs.length - 1], references);

    if (isFnComplete.reason === 'fewArgs') {
      const fnDef = getFunctionDefinition(nodeArg.name);
      if (
        fnDef?.signatures.every(({ params }) =>
          params.some(({ type }) => isArrayType(type as string))
        )
      ) {
        suggestions.push(listCompleteItem);
      } else {
        const finalType = nestedType || nodeArgType || 'any';
        const supportedTypes = getSupportedTypesForBinaryOperators(fnDef, finalType as string);
        suggestions.push(
          ...(await getFieldsOrFunctionsSuggestions(
            // this is a special case with AND/OR
            // <COMMAND> expression AND/OR <suggest>
            // technically another boolean value should be suggested, but it is a better experience
            // to actually suggest a wider set of fields/functions
            finalType === 'boolean' && getFunctionDefinition(nodeArg.name)?.type === 'builtin'
              ? ['any']
              : (supportedTypes as string[]),
            command.name,
            option?.name,
            getFieldsByType,
            {
              functions: true,
              fields: true,
              variables: references.variables,
            }
          ))
        );
      }
    }
    if (isFnComplete.reason === 'wrongTypes') {
      if (nestedType) {
        // suggest something to complete the builtin function
        if (nestedType !== argDef.type) {
          suggestions.push(
            ...getBuiltinCompatibleFunctionDefinition(
              command.name,
              undefined,
              nestedType,
              [argDef.type],
              workoutBuiltinOptions(nodeArg, references)
            )
          );
        }
      }
    }
  }
  return suggestions.map<SuggestionRawDefinition>((s) => {
    const overlap = getOverlapRange(queryText, s.text);
    return {
      ...s,
      rangeToReplace: {
        start: overlap.start,
        end: overlap.end,
      },
    };
  });
}

function pushItUpInTheList(suggestions: SuggestionRawDefinition[], shouldPromote: boolean) {
  if (!shouldPromote) {
    return suggestions;
  }
  return suggestions.map(({ sortText, ...rest }) => ({
    ...rest,
    sortText: `1${sortText}`,
  }));
}

/**
 * TODO — split this into distinct functions, one for fields, one for functions, one for literals
 */
async function getFieldsOrFunctionsSuggestions(
  types: string[],
  commandName: string,
  optionName: string | undefined,
  getFieldsByType: GetFieldsByTypeFn,
  {
    functions,
    fields,
    variables,
    literals = false,
  }: {
    functions: boolean;
    fields: boolean;
    variables?: Map<string, ESQLVariable[]>;
    literals?: boolean;
  },
  {
    ignoreFn = [],
    ignoreFields = [],
  }: {
    ignoreFn?: string[];
    ignoreFields?: string[];
  } = {}
): Promise<SuggestionRawDefinition[]> {
  const filteredFieldsByType = pushItUpInTheList(
    (await (fields
      ? getFieldsByType(types, ignoreFields, {
          advanceCursorAndOpenSuggestions: commandName === 'sort',
        })
      : [])) as SuggestionRawDefinition[],
    functions
  );

  const filteredVariablesByType: string[] = [];
  if (variables) {
    for (const variable of variables.values()) {
      if (types.includes('any') || types.includes(variable[0].type)) {
        filteredVariablesByType.push(variable[0].name);
      }
    }
    // due to a bug on the ES|QL table side, filter out fields list with underscored variable names (??)
    // avg( numberField ) => avg_numberField_
    const ALPHANUMERIC_REGEXP = /[^a-zA-Z\d]/g;
    if (
      filteredVariablesByType.length &&
      filteredVariablesByType.some((v) => ALPHANUMERIC_REGEXP.test(v))
    ) {
      for (const variable of filteredVariablesByType) {
        // remove backticks if present
        const sanitizedVariable = variable.startsWith(SINGLE_BACKTICK)
          ? variable.slice(1, variable.length - 1)
          : variable;
        const underscoredName = sanitizedVariable.replace(ALPHANUMERIC_REGEXP, '_');
        const index = filteredFieldsByType.findIndex(
          ({ label }) => underscoredName === label || `_${underscoredName}_` === label
        );
        if (index >= 0) {
          filteredFieldsByType.splice(index);
        }
      }
    }
  }

  const suggestions = filteredFieldsByType.concat(
    functions ? getCompatibleFunctionDefinition(commandName, optionName, types, ignoreFn) : [],
    variables
      ? pushItUpInTheList(buildVariablesDefinitions(filteredVariablesByType), functions)
      : [],
    literals ? getCompatibleLiterals(commandName, types) : []
  );

  return suggestions;
}

const addCommaIf = (condition: boolean, text: string) => (condition ? `${text},` : text);

async function getFunctionArgsSuggestions(
  innerText: string,
  commands: ESQLCommand[],
  {
    command,
    option,
    node,
  }: {
    command: ESQLCommand;
    option: ESQLCommandOption | undefined;
    node: ESQLFunction;
  },
  getFieldsByType: GetFieldsByTypeFn,
  getFieldsMap: GetFieldsMapFn,
  getPolicyMetadata: GetPolicyMetadataFn
): Promise<SuggestionRawDefinition[]> {
  const fnDefinition = getFunctionDefinition(node.name);
  // early exit on no hit
  if (!fnDefinition) {
    return [];
  }
  const fieldsMap: Map<string, ESQLRealField> = await getFieldsMap();
  const variablesExcludingCurrentCommandOnes = excludeVariablesFromCurrentCommand(
    commands,
    command,
    fieldsMap,
    innerText
  );
  // pick the type of the next arg
  const shouldGetNextArgument = node.text.includes(EDITOR_MARKER);
  let argIndex = Math.max(node.args.length, 0);
  if (!shouldGetNextArgument && argIndex) {
    argIndex -= 1;
  }

  const arg = node.args[argIndex];

  // the first signature is used as reference
  // TODO - take into consideration all signatures that match the current args
  const refSignature = fnDefinition.signatures[0];

  const hasMoreMandatoryArgs =
    (refSignature.params.length >= argIndex &&
      refSignature.params.filter(({ optional }, index) => !optional && index > argIndex).length >
        0) ||
    ('minParams' in refSignature && refSignature.minParams
      ? refSignature.minParams - 1 > argIndex
      : false);

  const shouldAddComma = hasMoreMandatoryArgs && fnDefinition.type !== 'builtin';

  const suggestedConstants = Array.from(
    new Set(
      fnDefinition.signatures.reduce<string[]>((acc, signature) => {
        const p = signature.params[argIndex];
        if (!p) {
          return acc;
        }

        const _suggestions: string[] = p.literalSuggestions
          ? p.literalSuggestions
          : p.literalOptions
          ? p.literalOptions
          : [];

        return acc.concat(_suggestions);
      }, [] as string[])
    )
  );

  if (suggestedConstants.length) {
    return buildValueDefinitions(suggestedConstants, {
      addComma: hasMoreMandatoryArgs,
      advanceCursorAndOpenSuggestions: hasMoreMandatoryArgs,
    });
  }

  const suggestions: SuggestionRawDefinition[] = [];
  const noArgDefined = !arg;
  const isUnknownColumn =
    arg &&
    isColumnItem(arg) &&
    !getColumnExists(arg, {
      fields: fieldsMap,
      variables: variablesExcludingCurrentCommandOnes,
    });
  if (noArgDefined || isUnknownColumn) {
    // ... | EVAL fn( <suggest>)
    // ... | EVAL fn( field, <suggest>)

    const commandArgIndex = command.args.findIndex(
      (cmdArg) => isSingleItem(cmdArg) && cmdArg.location.max >= node.location.max
    );
    const finalCommandArgIndex =
      command.name !== 'stats'
        ? -1
        : commandArgIndex < 0
        ? Math.max(command.args.length - 1, 0)
        : commandArgIndex;

    const finalCommandArg = command.args[finalCommandArgIndex];

    const fnToIgnore = [];
    // just ignore the current function
    if (
      command.name !== 'stats' ||
      (isOptionItem(finalCommandArg) && finalCommandArg.name === 'by')
    ) {
      fnToIgnore.push(node.name);
    } else {
      fnToIgnore.push(
        ...getFunctionsToIgnoreForStats(command, finalCommandArgIndex),
        ...(isAggFunctionUsedAlready(command, finalCommandArgIndex)
          ? getAllFunctions({ type: 'agg' }).map(({ name }) => name)
          : [])
      );
    }

    const existingTypes = node.args
      .map((nodeArg) =>
        extractFinalTypeFromArg(nodeArg, {
          fields: fieldsMap,
          variables: variablesExcludingCurrentCommandOnes,
        })
      )
      .filter(nonNullable);

    const validSignatures = fnDefinition.signatures
      // if existing arguments are preset already, use them to filter out incompatible signatures
      .filter((signature) => {
        if (existingTypes.length) {
          return existingTypes.every((type, index) =>
            compareTypesWithLiterals(signature.params[index].type, type)
          );
        }
        return true;
      });

    /**
     * Get all parameter definitions across all function signatures
     * for the current parameter position in the given function definition,
     */
    const allParamDefinitionsForThisPosition = validSignatures
      .map((signature) => getParamAtPosition(signature, argIndex))
      .filter(nonNullable);

    // Separate the param definitions into two groups:
    // fields should only be suggested if the param isn't constant-only,
    // and constant suggestions should only be given if it is.
    //
    // TODO - consider incorporating the literalOptions into this
    //
    // TODO — improve this to inherit the constant flag from the outer function
    // (e.g. if func1's first parameter is constant-only, any nested functions should
    // inherit that constraint: func1(func2(shouldBeConstantOnly)))
    //
    const [constantOnlyParamDefs, paramDefsWhichSupportFields] = partition(
      allParamDefinitionsForThisPosition,
      (paramDef) => paramDef.constantOnly || /_literal$/.test(paramDef.type as string)
    );

    const getTypesFromParamDefs = (paramDefs: FunctionParameter[]) => {
      return Array.from(new Set(paramDefs.map(({ type }) => type)));
    };

    // Literals
    suggestions.push(
      ...getCompatibleLiterals(
        command.name,
        getTypesFromParamDefs(constantOnlyParamDefs) as string[],
        undefined,
        { addComma: shouldAddComma, advanceCursorAndOpenSuggestions: hasMoreMandatoryArgs }
      )
    );

    // Fields
    suggestions.push(
      ...pushItUpInTheList(
        await getFieldsByType(getTypesFromParamDefs(paramDefsWhichSupportFields) as string[], [], {
          addComma: shouldAddComma,
          advanceCursorAndOpenSuggestions: hasMoreMandatoryArgs,
        }),
        true
      )
    );

    // Functions
    suggestions.push(
      ...getCompatibleFunctionDefinition(
        command.name,
        option?.name,
        getTypesFromParamDefs(paramDefsWhichSupportFields) as string[],
        fnToIgnore
      ).map((suggestion) => ({
        ...suggestion,
        text: addCommaIf(shouldAddComma, suggestion.text),
      }))
    );

    // could also be in stats (bucket) but our autocomplete is not great yet
    if (
      getTypesFromParamDefs(paramDefsWhichSupportFields).includes('date') &&
      ['where', 'eval'].includes(command.name)
    )
      suggestions.push(
        ...getDateLiterals({
          addComma: shouldAddComma,
          advanceCursorAndOpenSuggestions: hasMoreMandatoryArgs,
        })
      );
  }

  // for eval and row commands try also to complete numeric literals with time intervals where possible
  if (arg) {
    if (command.name !== 'stats') {
      if (isLiteralItem(arg) && isNumericType(arg.literalType)) {
        // ... | EVAL fn(2 <suggest>)
        suggestions.push(
          ...getCompatibleLiterals(command.name, ['time_literal_unit'], undefined, {
            addComma: shouldAddComma,
            advanceCursorAndOpenSuggestions: hasMoreMandatoryArgs,
          })
        );
      }
    }

    if (hasMoreMandatoryArgs) {
      // suggest a comma if there's another argument for the function
      suggestions.push(commaCompleteItem);
    }
  }

  return suggestions;
}

async function getListArgsSuggestions(
  innerText: string,
  commands: ESQLCommand[],
  {
    command,
    node,
  }: {
    command: ESQLCommand;
    node: ESQLSingleAstItem | undefined;
  },
  getFieldsByType: GetFieldsByTypeFn,
  getFieldsMaps: GetFieldsMapFn,
  getPolicyMetadata: GetPolicyMetadataFn
) {
  const suggestions = [];
  // node is supposed to be the function who support a list argument (like the "in" operator)
  // so extract the type of the first argument and suggest fields of that type
  if (node && isFunctionItem(node)) {
    const fieldsMap: Map<string, ESQLRealField> = await getFieldsMaps();
    const anyVariables = collectVariables(commands, fieldsMap, innerText);
    // extract the current node from the variables inferred
    anyVariables.forEach((values, key) => {
      if (values.some((v) => v.location === node.location)) {
        anyVariables.delete(key);
      }
    });
    const [firstArg] = node.args;
    if (isColumnItem(firstArg)) {
      const argType = extractFinalTypeFromArg(firstArg, {
        fields: fieldsMap,
        variables: anyVariables,
      });
      if (argType) {
        // do not propose existing columns again
        const otherArgs = node.args.filter(Array.isArray).flat().filter(isColumnItem);
        suggestions.push(
          ...(await getFieldsOrFunctionsSuggestions(
            [argType as string],
            command.name,
            undefined,
            getFieldsByType,
            {
              functions: true,
              fields: true,
              variables: anyVariables,
            },
            { ignoreFields: [firstArg.name, ...otherArgs.map(({ name }) => name)] }
          ))
        );
      }
    }
  }
  return suggestions;
}

async function getSettingArgsSuggestions(
  innerText: string,
  commands: ESQLCommand[],
  {
    command,
    node,
  }: {
    command: ESQLCommand;
    node: ESQLSingleAstItem | undefined;
  },
  getFieldsByType: GetFieldsByTypeFn,
  getFieldsMaps: GetFieldsMapFn,
  getPolicyMetadata: GetPolicyMetadataFn
) {
  const suggestions = [];

  const settingDefs = getCommandDefinition(command.name).modes;

  if (settingDefs.length) {
    const lastChar = getLastCharFromTrimmed(innerText);
    const matchingSettingDefs = settingDefs.filter(({ prefix }) => lastChar === prefix);
    if (matchingSettingDefs.length) {
      // COMMAND _<here>
      suggestions.push(...matchingSettingDefs.flatMap(buildSettingDefinitions));
    }
  }
  return suggestions;
}

async function getOptionArgsSuggestions(
  innerText: string,
  commands: ESQLCommand[],
  {
    command,
    option,
    node,
  }: {
    command: ESQLCommand;
    option: ESQLCommandOption;
    node: ESQLSingleAstItem | undefined;
  },
  getFieldsByType: GetFieldsByTypeFn,
  getFieldsMaps: GetFieldsMapFn,
  getPolicyMetadata: GetPolicyMetadataFn
) {
  const optionDef = getCommandOption(option.name);
  const { nodeArg, argIndex, lastArg } = extractArgMeta(option, node);
  const suggestions = [];
  const isNewExpression = isRestartingExpression(innerText) || option.args.length === 0;

  const fieldsMap = await getFieldsMaps();
  const anyVariables = collectVariables(commands, fieldsMap, innerText);

  const references = {
    fields: fieldsMap,
    variables: anyVariables,
  };
  if (command.name === 'enrich') {
    if (option.name === 'on') {
      // if it's a new expression, suggest fields to match on
      if (
        isNewExpression ||
        findPreviousWord(innerText) === 'ON' ||
        (option && isAssignment(option.args[0]) && !option.args[1])
      ) {
        const policyName = isSourceItem(command.args[0]) ? command.args[0].name : undefined;
        if (policyName) {
          const policyMetadata = await getPolicyMetadata(policyName);
          if (policyMetadata) {
            suggestions.push(
              ...buildMatchingFieldsDefinition(
                policyMetadata.matchField,
                Array.from(fieldsMap.keys())
              )
            );
          }
        }
      } else {
        // propose the with option
        suggestions.push(
          buildOptionDefinition(getCommandOption('with')!),
          ...getFinalSuggestions({
            comma: true,
          })
        );
      }
    }
    if (option.name === 'with') {
      const policyName = isSourceItem(command.args[0]) ? command.args[0].name : undefined;
      if (policyName) {
        const policyMetadata = await getPolicyMetadata(policyName);
        const anyEnhancedVariables = collectVariables(
          commands,
          appendEnrichFields(fieldsMap, policyMetadata),
          innerText
        );

        if (isNewExpression || noCaseCompare(findPreviousWord(innerText), 'WITH')) {
          suggestions.push(buildNewVarDefinition(findNewVariable(anyEnhancedVariables)));
        }

        // make sure to remove the marker arg from the assign fn
        const assignFn = isAssignment(lastArg)
          ? (removeMarkerArgFromArgsList(lastArg) as ESQLFunction)
          : undefined;

        if (policyMetadata) {
          if (isNewExpression || (assignFn && !isAssignmentComplete(assignFn))) {
            // ... | ENRICH ... WITH a =
            suggestions.push(...buildFieldsDefinitions(policyMetadata.enrichFields));
          }
        }
        if (
          assignFn &&
          hasSameArgBothSides(assignFn) &&
          !isNewExpression &&
          !isIncompleteItem(assignFn)
        ) {
          // ... | ENRICH ... WITH a
          // effectively only assign will apper
          suggestions.push(
            ...pushItUpInTheList(
              getBuiltinCompatibleFunctionDefinition(command.name, undefined, 'any'),
              true
            )
          );
        }

        if (
          assignFn &&
          (isAssignmentComplete(assignFn) || hasSameArgBothSides(assignFn)) &&
          !isNewExpression
        ) {
          suggestions.push(
            ...getFinalSuggestions({
              comma: true,
            })
          );
        }
      }
    }
  }
  if (command.name === 'rename') {
    if (option.args.length < 2) {
      suggestions.push(...buildVariablesDefinitions([findNewVariable(anyVariables)]));
    }
  }

  if (command.name === 'dissect') {
    if (
      option.args.filter((arg) => !(isSingleItem(arg) && arg.type === 'unknown')).length < 1 &&
      optionDef
    ) {
      suggestions.push(colonCompleteItem, semiColonCompleteItem);
    }
  }

  if (option.name === 'metadata') {
    const existingFields = new Set(option.args.filter(isColumnItem).map(({ name }) => name));
    const filteredMetaFields = METADATA_FIELDS.filter((name) => !existingFields.has(name));
    if (isNewExpression) {
      suggestions.push(...buildFieldsDefinitions(filteredMetaFields));
    } else if (existingFields.size > 0) {
      if (filteredMetaFields.length > 0) {
        suggestions.push(commaCompleteItem);
      }
      suggestions.push(pipeCompleteItem);
    }
  }

  if (command.name === 'stats') {
    const argDef = optionDef?.signature.params[argIndex];

    const nodeArgType = extractFinalTypeFromArg(nodeArg, references);
    // These cases can happen here, so need to identify each and provide the right suggestion
    // i.e. ... | STATS ... BY field + <suggest>
    // i.e. ... | STATS ... BY field >= <suggest>

    if (nodeArgType) {
      if (isFunctionItem(nodeArg) && !isFunctionArgComplete(nodeArg, references).complete) {
        suggestions.push(
          ...(await getBuiltinFunctionNextArgument(
            innerText,
            command,
            option,
            { type: argDef?.type || 'any' },
            nodeArg,
            nodeArgType as string,
            references,
            getFieldsByType
          ))
        );
      }
    }

    // If it's a complete expression then propose some final suggestions
    if (
      (!nodeArgType &&
        option.name === 'by' &&
        option.args.length &&
        !isNewExpression &&
        !isAssignment(lastArg)) ||
      (isAssignment(lastArg) && isAssignmentComplete(lastArg))
    ) {
      suggestions.push(
        ...getFinalSuggestions({
          comma: optionDef?.signature.multipleParams ?? option.name === 'by',
        })
      );
    }
  }

  if (optionDef) {
    if (!suggestions.length) {
      const argDefIndex = optionDef.signature.multipleParams
        ? 0
        : Math.max(option.args.length - 1, 0);
      const types = [optionDef.signature.params[argDefIndex].type].filter(nonNullable);
      // If it's a complete expression then proposed some final suggestions
      // A complete expression is either a function or a column: <COMMAND> <OPTION> field <here>
      // Or an assignment complete: <COMMAND> <OPTION> field = ... <here>
      if (
        (option.args.length && !isNewExpression && !isAssignment(lastArg)) ||
        (isAssignment(lastArg) && isAssignmentComplete(lastArg))
      ) {
        suggestions.push(
          ...getFinalSuggestions({
            comma: optionDef.signature.multipleParams,
          })
        );
      } else if (isNewExpression || (isAssignment(nodeArg) && !isAssignmentComplete(nodeArg))) {
        suggestions.push(
          ...(await getFieldsByType(types[0] === 'column' ? ['any'] : types, [], {
            advanceCursorAndOpenSuggestions: true,
          }))
        );

        if (option.name === 'by') {
          suggestions.push(
            ...(await getFieldsOrFunctionsSuggestions(
              types[0] === 'column' ? ['any'] : types,
              command.name,
              option.name,
              getFieldsByType,
              {
                functions: true,
                fields: false,
              }
            ))
          );
        }

        if (command.name === 'stats' && isNewExpression) {
          suggestions.push(buildNewVarDefinition(findNewVariable(anyVariables)));
        }
      }
    }
  }
  return suggestions;
}
