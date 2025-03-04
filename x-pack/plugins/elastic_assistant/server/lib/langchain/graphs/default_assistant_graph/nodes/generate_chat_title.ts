/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { StringOutputParser } from '@langchain/core/output_parsers';

import { ChatPromptTemplate } from '@langchain/core/prompts';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AgentState, NodeParamsBase } from '../types';

export const GENERATE_CHAT_TITLE_PROMPT = (responseLanguage: string, llmType?: string) =>
  llmType === 'bedrock'
    ? ChatPromptTemplate.fromMessages([
        [
          'system',
          `You are a helpful assistant for Elastic Security. Assume the following user message is the start of a conversation between you and a user; give this conversation a title based on the content below. DO NOT UNDER ANY CIRCUMSTANCES wrap this title in single or double quotes. This title is shown in a list of conversations to the user, so title it for the user, not for you. Please create the title in ${responseLanguage}. Respond with the title only with no other text explaining your response. As an example, for the given MESSAGE, this is the TITLE:

    MESSAGE: I am having trouble with the Elastic Security app.
    TITLE: Troubleshooting Elastic Security app issues
    `,
        ],
        ['human', '{input}'],
      ])
    : llmType === 'gemini'
    ? ChatPromptTemplate.fromMessages([
        [
          'system',
          `You are a title generator for a helpful assistant for Elastic Security. Assume the following human message is the start of a conversation between you and a human; Do not respond to the human message, instead respond with conversation title relevant to the human's message. DO NOT UNDER ANY CIRCUMSTANCES use quotes or markdown in your response. This title is shown in a list of conversations to the human, so title it for the user, not for you. Please create the title in ${responseLanguage}. Respond with the title only with no other text explaining your response. As an example, for the given MESSAGE, this is the TITLE:

    MESSAGE: I am having trouble with the Elastic Security app.
    TITLE: Troubleshooting Elastic Security app issues
    `,
        ],
        ['human', '{input}'],
      ])
    : ChatPromptTemplate.fromMessages([
        [
          'system',
          `You are a helpful assistant for Elastic Security. Assume the following user message is the start of a conversation between you and a user; give this conversation a title based on the content below. DO NOT UNDER ANY CIRCUMSTANCES wrap this title in single or double quotes. This title is shown in a list of conversations to the user, so title it for the user, not for you. Please create the title in ${responseLanguage}. As an example, for the given MESSAGE, this is the TITLE:

    MESSAGE: I am having trouble with the Elastic Security app.
    TITLE: Troubleshooting Elastic Security app issues
    `,
        ],
        ['human', '{input}'],
      ]);

export interface GenerateChatTitleParams extends NodeParamsBase {
  llmType?: string;
  responseLanguage: string;
  state: AgentState;
  model: BaseChatModel;
}

export const GENERATE_CHAT_TITLE_NODE = 'generateChatTitle';

export const generateChatTitle = async ({
  llmType,
  responseLanguage,
  logger,
  model,
  state,
}: GenerateChatTitleParams) => {
  logger.debug(() => `Node state:\n ${JSON.stringify(state, null, 2)}`);

  const outputParser = new StringOutputParser();
  const graph = GENERATE_CHAT_TITLE_PROMPT(responseLanguage, llmType)
    .pipe(model)
    .pipe(outputParser);

  const chatTitle = await graph.invoke({
    input: JSON.stringify(state.input, null, 2),
  });
  logger.debug(`chatTitle: ${chatTitle}`);

  return {
    chatTitle,
  };
};
