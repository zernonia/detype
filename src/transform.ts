import { transformAsync } from "@babel/core";
import type { VisitNodeObject, Node } from "@babel/traverse";
import { format, Options as PrettierOptions } from "prettier";
import {
	parse as parseVueSfc,
	SFCTemplateBlock as VueSfcTemplateBlock,
	SFCScriptBlock as VueSfcScriptBlock,
} from "@vuedx/compiler-sfc";
import {
	traverse as traverseVueAst,
	isSimpleExpressionNode as isVueSimpleExpressionNode,
	isComponentNode as isVueComponentNode,
} from "@vuedx/template-ast-types";

type VueElementNode = VueSfcTemplateBlock["ast"];

// @ts-expect-error: No typinggs needed
import babelTs from "@babel/preset-typescript";

export async function transform(
	code: string,
	fileName: string,
	prettierOptions?: PrettierOptions | null,
): Promise<string> {
	const originalCode = code;
	const originalFileName = fileName;

	if (fileName.endsWith(".vue")) {
		const parsedVue = parseVueSfc(code, { filename: fileName });

		if (
			parsedVue.descriptor.script?.lang !== "ts" &&
			parsedVue.descriptor.scriptSetup?.lang !== "ts"
		) {
			// No TypeScript, don't touch it
			return originalCode;
		}

		let { script: script1, scriptSetup: script2 } = parsedVue.descriptor;

		// Process the second script first to simplify code location handling
		if (
			script1 &&
			script2 &&
			script1.loc.start.offset < script2.loc.start.offset
		) {
			[script2, script1] = [script1, script2];
		}

		code = await removeTypesFromVueSfcScript(
			code,
			fileName,
			script1,
			parsedVue.descriptor.template?.ast,
		);

		code = await removeTypesFromVueSfcScript(
			code,
			fileName,
			script2,
			parsedVue.descriptor.template?.ast,
		);
	} else {
		code = await removeTypes(code, fileName);
	}

	const prettierOutput = format(code, {
		...prettierOptions,
		filepath: originalFileName,
	});

	return prettierOutput;
}

async function removeTypes(code: string, fileName: string) {
	// Babel visitor to remove leading comments
	const removeComments: VisitNodeObject<unknown, Node> = {
		enter(p) {
			if (!p.node.leadingComments) return;

			for (let i = p.node.leadingComments.length - 1; i >= 0; i--) {
				const comment = p.node.leadingComments[i];

				if (code.slice(comment.end).match(/^\s*\n\s*\n/)) {
					// There is at least one empty line between the comment and the TypeScript specific construct
					// We should keep this comment and those before it
					break;
				}
				comment.value = "@detype: remove-me";
			}
		},
	};

	const babelOutput = await transformAsync(code, {
		filename: fileName,
		retainLines: true,
		plugins: [
			// Plugin to remove leading comments attached to TypeScript-only constructs
			{
				name: "detype-comment-remover",
				visitor: {
					TSTypeAliasDeclaration: removeComments,
					TSInterfaceDeclaration: removeComments,
					TSDeclareFunction: removeComments,
					TSDeclareMethod: removeComments,
					TSImportType: removeComments,
				},
			},
		],
		presets: [babelTs],
		generatorOpts: {
			shouldPrintComment: (comment) => comment !== "@detype: remove-me",
		},
	});

	if (
		!babelOutput ||
		babelOutput.code === undefined ||
		babelOutput.code === null
	) {
		throw new Error("Babel error");
	}

	return babelOutput.code;
}

async function removeTypesFromVueSfcScript(
	code: string,
	fileName: string,
	script: VueSfcScriptBlock | null,
	templateAst?: VueElementNode,
) {
	if (script === null || script.lang !== "ts") return code;

	if (script.setup && templateAst) {
		// Babel TypeScript preset removes unused exports thinking they may be type-only exports.
		// We have to mark every import that the template references to mark them as used.

		const expressions = new Set<string>();

		traverseVueAst(templateAst, {
			enter(node) {
				if (isVueSimpleExpressionNode(node) && !node.isStatic) {
					expressions.add(node.content);
				} else if (isVueComponentNode(node)) {
					expressions.add(node.tag);
				}
			},
		});

		// We'll simply add them at the end of the template

		script.content +=
			"/* @detype: remove-after-this */" + [...expressions].join(";");
	}

	let scriptCode = await removeTypes(script.content, fileName + ".ts");

	const removeAfterIndex = scriptCode.indexOf(
		"/* @detype: remove-after-this */",
	);

	if (removeAfterIndex >= 0) {
		scriptCode = scriptCode.slice(0, removeAfterIndex);
	}

	let before = code.slice(0, script.loc.start.offset);
	const after = code.slice(script.loc.end.offset);

	// We have to backtrack to remove lang="ts", not fool-proof but should work for all reasonable code
	const matches = before.match(/\blang\s*=\s*["']ts["']/);

	if (matches) {
		const lastMatch = matches[matches.length - 1];
		const lastMatchIndex = before.lastIndexOf(lastMatch);
		before =
			before.slice(0, lastMatchIndex) +
			before.slice(lastMatchIndex + lastMatch.length);
	}

	return before + scriptCode + after;
}
