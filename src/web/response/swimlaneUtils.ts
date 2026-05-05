import {
  Element as ElementSchema,
  Chain as ChainSchema,
} from "@netcracker/qip-schemas";
import { ActionDifference, CreateElementRequest } from "@netcracker/qip-ui";
import { findAndRemoveElementById, getDefaultElement } from "./chainApiModify";
import { getElementChildren } from "./chainApiUtils";
import { Uri } from "vscode";
import { parseElement, parseElements } from "./chainApiRead";

const SWIMLANE_TYPE_NAME = "swimlane";
const REUSE_SWIMLANE_NAME = "Reuse swimlane";

export function isDefaultSwimlane(element: ElementSchema, chain: ChainSchema) {
  return element.id === chain.content.defaultSwimlaneId;
}

export function isReuseSwimlane(element: ElementSchema, chain: ChainSchema) {
  return element.id === chain.content.reuseSwimlaneId;
}

export async function enrichElementWithSwimlaneId(
  fileUri: Uri,
  chain: ChainSchema,
  elementRequest: CreateElementRequest,
  newElement: ElementSchema,
  chainDiff: ActionDifference,
): Promise<void> {
  const chainElements = chain.content.elements as ElementSchema[];

  let swimlaneId = chain.content.defaultSwimlaneId as string;
  if (swimlaneId) {
    if (String(newElement.type) === "reuse") {
      if (!chain.content.reuseSwimlaneId) {
        swimlaneId = (await createReuseSwimlane(fileUri, chain, chainDiff)).id;
      }
    } else if (elementRequest.swimlaneId) {
      swimlaneId = findSwimlaneByIdOrError(
        chainElements,
        elementRequest.swimlaneId,
        chain.id,
      ).id;
    }
  }
  if (swimlaneId) {
    newElement.swimlaneId = swimlaneId;
  }
}

export function findSwimlaneByIdOrError(
  elements: ElementSchema[],
  swimlaneId: string,
  chainId: string,
): ElementSchema {
  const swimlane = elements.find(
    (element) =>
      String(element.type) === SWIMLANE_TYPE_NAME && element.id === swimlaneId,
  );
  if (!swimlane) {
    throw new Error(
      `Swimlane ${swimlaneId} does not exist in chain ${chainId}`,
    );
  }

  return swimlane;
}

export async function createReuseSwimlane(
  fileUri: Uri,
  chain: ChainSchema,
  chainDiff: ActionDifference,
): Promise<ElementSchema> {
  const chainElements = chain.content.elements as ElementSchema[];

  const reuseSwimlane: ElementSchema = await getDefaultElement(
    chain.id,
    SWIMLANE_TYPE_NAME,
  );
  reuseSwimlane.name = REUSE_SWIMLANE_NAME;
  (reuseSwimlane as any).properties.color = "Green";
  chainElements.push(reuseSwimlane);
  chain.content.reuseSwimlaneId = reuseSwimlane.id;
  chainDiff.createdReuseSwimlaneId = reuseSwimlane.id;

  chainDiff.createdElements?.push(
    await parseElement(fileUri, reuseSwimlane, chain.id),
  );

  return reuseSwimlane;
}

export async function createReuseSwimlaneAndUpdateElements(
  fileUri: Uri,
  chain: ChainSchema,
  chainDiff: ActionDifference,
) {
  const reuseSwimlane: ElementSchema = await createReuseSwimlane(
    fileUri,
    chain,
    chainDiff,
  );

  const updatedReuseElements = await updateSwimlaneForElements(
    reuseSwimlane.id,
    chain.content.elements as ElementSchema[],
    (element: ElementSchema) => String(element.type) === "reuse",
  );

  chainDiff.updatedElements?.push(
    ...(await parseElements(fileUri, updatedReuseElements, chain.id)),
  );
}

export async function deleteSwimlane(
  fileUri: Uri,
  swimlaneElement: ElementSchema,
  chain: ChainSchema,
): Promise<ActionDifference> {
  const chainDiff: ActionDifference = {
    removedElements: [],
    updatedElements: [],
  };

  if (isDefaultSwimlane(swimlaneElement, chain)) {
    deleteDefaultSwimlane(fileUri, chain, chainDiff);
  } else if (isReuseSwimlane(swimlaneElement, chain)) {
    const elementsInReuseSwimlane = (
      chain.content.elements as ElementSchema[]
    ).filter(
      (chainElement) => chainElement.swimlaneId === swimlaneElement.id,
    ).length;

    if (elementsInReuseSwimlane === 0) {
      deleteOnlySwimlane(fileUri, chain, swimlaneElement.id, chainDiff);
    } else {
      deleteDefaultSwimlane(fileUri, chain, chainDiff);
    }
  } else {
    if (chain.content.defaultSwimlaneId) {
      const updatedElements = await updateSwimlaneForElements(
        chain.content.defaultSwimlaneId as string,
        chain.content.elements as ElementSchema[],
        (element) => element.swimlaneId === swimlaneElement.id,
      );
      chainDiff.updatedElements?.push(
        ...(await parseElements(fileUri, updatedElements, chain.id)),
      );
      deleteOnlySwimlane(fileUri, chain, swimlaneElement.id, chainDiff);
    } else {
      deleteSwimlaneWithElements(fileUri, chain, swimlaneElement.id, chainDiff);
    }
  }

  return chainDiff;
}

async function deleteDefaultSwimlane(
  fileUri: Uri,
  chain: ChainSchema,
  chainDiff: ActionDifference,
) {
  const chainElements = chain.content.elements as ElementSchema[];

  const commonSwimlanesCount = chainElements.filter(
    (element) =>
      !isDefaultSwimlane(element, chain) && !isReuseSwimlane(element, chain),
  ).length;

  if (commonSwimlanesCount > 0) {
    throw new Error(
      "Default and Reuse swimlanes cannot be removed if the chain contains other swimlanes",
    );
  }

  deleteSwimlaneWithElements(
    fileUri,
    chain,
    chain.content.defaultSwimlaneId as string,
    chainDiff,
  );

  if (chain.content.reuseSwimlaneId) {
    deleteSwimlaneWithElements(
      fileUri,
      chain,
      chain.content.reuseSwimlaneId as string,
      chainDiff,
    );
  }
}

async function deleteSwimlaneWithElements(
  fileUri: Uri,
  chain: ChainSchema,
  swimlaneId: string,
  chainDiff: ActionDifference,
) {
  deleteOnlySwimlane(fileUri, chain, swimlaneId, chainDiff);

  const updatedElements = await updateSwimlaneForElements(
    undefined,
    chain.content.elements as ElementSchema[],
    (element) => element.swimlaneId === swimlaneId,
  );
  chainDiff.updatedElements?.push(
    ...(await parseElements(fileUri, updatedElements, chain.id)),
  );
}

async function deleteOnlySwimlane(
  fileUri: Uri,
  chain: ChainSchema,
  swimlaneId: string,
  chainDiff: ActionDifference,
) {
  const chainElements = chain.content.elements as ElementSchema[];

  const deletedSwimlane = findAndRemoveElementById(chainElements, swimlaneId)!;

  if (swimlaneId === chain.content.defaultSwimlaneId) {
    chain.content.defaultSwimlaneId = undefined;
  } else if (swimlaneId === chain.content.reuseSwimlaneId) {
    chain.content.reuseSwimlaneId = undefined;
  }

  chainDiff.removedElements?.push(
    await parseElement(fileUri, deletedSwimlane, chain.id),
  );
}

export async function updateSwimlaneForElements(
  swimlaneId: string | undefined,
  chainElements: ElementSchema[],
  predicate: (element: ElementSchema) => boolean,
): Promise<ElementSchema[]> {
  const nonSwimlaneElements = chainElements.filter(
    (element) => SWIMLANE_TYPE_NAME !== String(element.type),
  );
  const updatedElements: ElementSchema[] = [];
  for (const element of nonSwimlaneElements) {
    if (predicate(element)) {
      updateSwimlaneId(element, swimlaneId);
      updatedElements.push(element);
    }
  }
  return updatedElements;
}

function updateSwimlaneId(element: ElementSchema, swimlaneId?: string) {
  element.swimlaneId = swimlaneId;
  for (const child of getElementChildren(element.children as ElementSchema[])) {
    updateSwimlaneId(child, swimlaneId);
  }
}
