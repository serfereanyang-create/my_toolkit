import { spawnSubAgentTool } from './subagent.js';
import { excelAutomateTool } from './excel.js';
import { tsHoverTool, tsGotoDefinitionTool, tsExactReferencesTool } from './tsLanguage.js';
import { recentActivityTool } from './activity.js';
import { cacheProbeTool } from './cacheProbe.js';
import { diskInfoTool } from './disk.js';
import { createDocxTool } from './docx.js';
import { createDocxTableTool } from './docx-table.js';
import { insertDocxImageTool } from './docx-image.js';
import { createPptxTool } from './pptx.js';
import { convertToPdfTool } from './pdf-convert.js';
import { pdfToTextTool } from './pdf-text.js';
import { docxToTextTool } from './docx-text.js';
import { environmentInfoTool } from './environment.js';
import { gitDiffTool, gitLogTool, gitStatusTool, gitDiffStagedTool } from './git.js';
import { diskGrowthTool } from './growth.js';
import { applyPatchTool } from './patch.js';
import { processMemoryTool } from './process.js';
import { projectIndexTool } from './projectIndex.js';
import { findReferencesTool, findSymbolTool } from './nav.js';
import { repoMapTool } from './repoMap.js';
import { renameFileTool } from './rename.js';
import { projectStatusTool, listFilesTool, readFileTool, writeFileTool } from './files.js';
import { ToolRegistry } from './registry.js';
import { searchTextTool } from './search.js';
import { runCommandTool } from './shell.js';
import { pollCommandTool } from './pollCommand.js';
import { fetchUrlTool, downloadFileTool, httpPostTool, parseUrlTool, extractPageLinksTool } from './web.js';
import { createXlsxTool } from './xlsx.js';
import { readCsvTool, writeCsvTool, csvStatsTool, csvPreviewTool } from './csv.js';
import { readJsonTool, jsonKeysTool, jsonTypeSummaryTool, jsonMergeTool } from './dataFile.js';
import { webSearchTool } from './search-web.js';
import { htmlToTextTool, htmlLinksTool, htmlMetadataTool, htmlHeadingsTool } from './html-text.js';
import { markdownToHtmlTool, markdownOutlineTool, markdownLinksTool, markdownCodeBlocksTool } from './markdown.js';
import { imageInfoTool, imageBatchInfoTool, imageAspectRatioTool, imageDominantColorsTool, imageTransparencyTool, imageContentBoundsTool } from './image-info.js';
import { yamlParseTool, yamlStringifyTool, yamlQueryTool, yamlKeysTool } from './yaml.js';
import { xmlToTextTool, xmlSummaryTool, xmlQueryTool } from './xml-tools.js';
import { iniParseTool, propertiesParseTool, tomlParseTool } from './config-parse.js';
import { rtfToTextTool } from './rtf.js';
import { createZipTool, listZipTool, extractZipTool, zipSummaryTool } from './zip.js';
import { fileInfoTool, makeDirTool, copyFileTool, deletePathTool, findFilesTool, countFilesTool } from './fsextra.js';
import { wordCountTool, headTailTool, sortLinesTool, replaceTextTool, extractMatchesTool } from './textutil.js';
import { trimTextTool, stripEmptyLinesTool, dedupeLinesTool, filterLinesTool, textSliceTool, extractBetweenTool, textCaseTool, reverseTextTool, splitTextTool, joinTextTool, textFrequencyTool, linePrefixTool, lineSuffixTool } from './text-extra.js';
import { textContainsTool, textStartsWithTool, textEndsWithTool, textRepeatTool, textTruncateTool, textIndexOfTool, charAtTool, commonPrefixTextTool, commonSuffixTextTool, lineNumbersTool, lineLengthsTool, longestLineTool, shortestLineTool, firstNonemptyLineTool, lastNonemptyLineTool, countSubstringTool } from './text-extra2.js';
import { textEqualsTool, textCompareTool, textPadTool, textWrapTool, textUnwrapTool, textRemovePrefixTool, textRemoveSuffixTool, nthLineTool, takeLinesTool, dropLinesTool, lineContainsTool, textSlugifyTool, textSurroundTool, textRepeatLinesTool, textLengthTool, textIsEmptyTool } from './text-extra3.js';
import { base64EncodeTool, base64DecodeTool, hashTextTool, urlEncodeTool, urlDecodeTool, uuidGenerateTool } from './encoding.js';
import { numberSumTool, numberAverageTool, numberMedianTool, numberMinMaxTool, numberStatsTool, roundNumberTool, clampNumberTool, percentageOfTool, sequenceGenerateTool, baseConvertTool, parseByteSizeTool, formatDurationTool, ratioSimplifyTool } from './number-extra.js';
import { numberAbsTool, numberSignTool, numberCompareTool, numberSortTool, numberUniqueTool, numberProductTool, percentageChangeTool, byteSizeFormatTool, durationParseTool, numberRangeCheckTool, numberScaleTool, numberModuloTool, numberHistogramTool, numberCumsumTool, numberPercentileTool, linearInterpolateTool } from './number-extra2.js';
import { currentDatetimeTool, dateDiffTool, calculateTool } from './compute.js';
import { pathExistsTool, pathNormalizeTool, pathJoinTool, pathRelativeTool, pathDirnameTool, pathBasenameTool, pathExtnameTool, pathPartsTool, listDirsTool, recentFilesTool, largestFilesTool, directorySummaryTool } from './path-extra2.js';
import { pathIsAbsoluteTool, pathChangeExtTool, pathAncestorsTool, pathDepthTool, pathCommonPrefixTool, pathMatchesGlobTool, fileExtensionsInDirTool, emptyDirsTool, siblingFilesTool, duplicateFilenamesTool, pathCompareTool, pathStemTool, pathParentTool, hiddenFilesTool, directoryDepthSummaryTool, nearestAncestorWithTool } from './path-extra3.js';
import { filename_searchTool } from './filename-search.js';
import { analysisTools } from '../analysis/tools.js';
import { refactorTools } from '../refactor/tools.js';
import { aiTools } from '../ai/tools.js';
import { testingTools } from '../testing/tools.js';
import { performanceTools } from '../performance/tools.js';
import { docTools } from '../docs/tools.js';
import { docTools as docGenTools } from '../docs/docTools.js';
import { auditTools } from '../audit/tools.js';
import { codegenTools } from '../codegen/tools.js';
import { workflowTools } from '../workflow/tools.js';
import { qualityTools } from '../quality/tools.js';
import { qualityHistoryTool } from './qualityHistory.js';
import { testTools } from '../testing/testTools.js';
import { reviewTools } from '../prreview/reviewTools.js';
import { dependencyTools } from '../prreview/depTools.js';
import { i18nTools } from '../prreview/i18nTools.js';
import { licenseTools } from '../prreview/licenseTools.js';
import { hotspotTools } from '../prreview/hotspotTools.js';
import { unusedExportTools } from '../prreview/unusedExportTools.js';
import { todoTools } from '../prreview/todoTools.js';
import { cycleTools } from '../prreview/cycleTools.js';
import { conflictTools } from '../prreview/conflictTools.js';
import { paramTools } from '../prreview/paramTools.js';
import { namingTools } from '../prreview/namingTools.js';
import { unusedImportTools } from '../prreview/unusedImportsTool.js';
import { eslintTools } from '../prreview/eslintTools.js';
import { classMetricsTools } from '../prreview/classMetricsTool.js';
import { commentTools } from '../prreview/commentTools.js';
import { tsMigrationTools } from '../prreview/tsMigrationTool.js';
import { dupDepsTools } from '../prreview/dupDepsTool.js';
import { workspaceTools } from '../workspace/workspaceTools.js';
import { packageDepsTools } from '../workspace/packageDepsTool.js';
import { workspaceGraphTools } from '../workspace/graphTool.js';
import { workspaceFilterTools } from '../workspace/filterTool.js';
import { workspaceRunTools } from '../workspace/workspaceRunTool.js';
import { workspaceHistoryTools } from '../workspace/workspaceHistoryTools.js';
import { unifiedPatchTools } from '../workspace/unifiedPatchTool.js';
import { langStatsTools } from '../workspace/langStatsTool.js';
import { gitQualityTools } from '../workspace/gitQualityTool.js';
import { scaffoldTools } from '../scaffold/scaffoldTool.js';
import { openapiTools } from '../openapi/openapiTool.js';
import { skillTools } from '../skills/index.js';
import { reflectionTools } from '../reflection/tools.js';
import { lockfileTools } from '../prreview/lockfileDiffTool.js';
import { structureAuditTools } from '../analysis/structureAuditTool.js';
import { sessionAnalyticsTools } from '../usage/sessionAnalyticsTool.js';
import { prDescriptionTools } from '../prreview/prDescriptionTool.js';
import { commitAnalyzerTools } from '../prreview/commitAnalyzerTool.js';
import { memoryDigestTools } from '../memory/memoryDigestTool.js';
import { commitLintTools } from '../prreview/commitLintTool.js';
import { reviewChecklistTools } from '../prreview/reviewChecklistTool.js';
import { sessionTitleTools } from '../session/sessionTitleTool.js';
import { versionBumpTools } from '../prreview/versionBumpTool.js';
import { envContractTools } from '../config/envContractTool.js';
import { reviewLoopBaseTool } from '../subagent/reviewLoopTool.js';
import { suggestionTools } from '../suggestions/tools.js';
import { healthTools } from '../health/tools.js';
import { cacheHealthTools } from './cacheHealth.js';
import { listCountTool, listUniqueTool, listSortTool, listReverseTool, listSliceTool, listChunkTool, listUnionTool, listIntersectTool, listDiffTool, listContainsTool, listFrequencyTool, listJoinTool, listIndexOfTool, listFlattenTool, listZipTool2 } from './list-extra.js';
import { readManyFilesTool, globFilesTool, diffFilesTool, editLinesTool, writeJsonTool, formatJsonTool, jsonToCsvTool, csvToJsonTool, listTreeTool } from './datatools2.js';
import { readLinesTool, appendFileTool, envGetTool, whichCommandTool } from './sysextra.js';
import {
  gitInitTool, gitAddTool, gitCommitTool, gitBranchTool, gitCheckoutTool, gitStashTool, gitShowTool, gitBlameTool,
  gitFetchTool, gitPullTool, gitMergeTool, gitCherryPickTool, gitTagTool,
  gitResetTool, gitRestoreTool,
} from './git-write.js';
import { listScriptsTool, runScriptTool, installDepsTool, typecheckTool, runTestsTool, lintTool, dependencyTreeTool, outdatedDepsTool } from './projectops.js';
import { analyzeComplexityTool, analyzeSmellsTool, analyzeDependenciesTool } from '../analysis/tools.js';
import { extractMethodTool, renameSymbolTool, quickRenameTool } from '../refactor/tools.js';
import { explainCodeTool, reviewCodeTool, generateDocTool, explainDiffTool, reviewDiffTool, securityCheckTool } from '../ai/tools.js';
import { generateTestsTool, generateFunctionTestTool, analyzeCoverageTool, fileCoverageTool, coverageGateTool } from '../testing/tools.js';
import { analyzePerformanceTool, performanceSuggestionsTool } from '../performance/tools.js';
import { generateAPIDocTool, generateArchitectureDocTool, generateChangelogTool, recommendVersionTool, generateReleaseNotesTool } from '../docs/tools.js';
import { queryCallGraphTool, impactAnalysisTool, queryTypeRelationsTool, buildCodeGraphTool } from './graph.js';
import { semanticSearchTool, findSimilarCodeTool, detectCodeClonesTool, semanticIndexStatsTool, buildSemanticIndexTool } from './semantic.js';
import { codebaseSearchTool } from './codebase.js';

export function createDefaultToolRegistry(options?: { excelAutomation?: boolean }) {
  const registry = new ToolRegistry();
  registry.register(projectStatusTool);
  registry.register(recentActivityTool);
  // Precise TS language tools (compiler-backed) — complement the heuristic
  // find_symbol/find_references with type-aware lookups.
  registry.register(tsHoverTool);
  registry.register(tsGotoDefinitionTool);
  registry.register(tsExactReferencesTool);
  registry.register(environmentInfoTool);
  registry.register(cacheProbeTool);
  registry.register(projectIndexTool);
  registry.register(repoMapTool);
  // Code quality, refactoring, AI, testing, performance, docs, and indexing tools
  registry.register(codebaseSearchTool);        // Unified search (auto-routing)
  registry.register(queryCallGraphTool);        // Call graph queries
  registry.register(buildCodeGraphTool);        // Code graph build/refresh
  registry.register(impactAnalysisTool);        // Impact analysis
  registry.register(queryTypeRelationsTool);    // Type relations
  registry.register(semanticSearchTool);        // Semantic code search
  registry.register(buildSemanticIndexTool);    // Semantic index build (incremental)
  registry.register(findSimilarCodeTool);       // Find similar code
  registry.register(detectCodeClonesTool);      // Code clone detection
  registry.register(semanticIndexStatsTool);    // Index statistics
  registry.register(findSymbolTool);            // Symbol search (BM25)
  registry.register(findReferencesTool);        // Reference search
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitDiffStagedTool);
  registry.register(gitLogTool);
  registry.register(listFilesTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(searchTextTool);
  registry.register(processMemoryTool);
  registry.register(diskInfoTool);
  registry.register(diskGrowthTool);
  registry.register(runCommandTool);
  registry.register(pollCommandTool);
  registry.register(createDocxTool);
  registry.register(createDocxTableTool);
  registry.register(insertDocxImageTool);
  registry.register(createPptxTool);
  registry.register(createXlsxTool);
  registry.register(convertToPdfTool);
  registry.register(pdfToTextTool);
  registry.register(docxToTextTool);
  registry.register(renameFileTool);
  registry.register(applyPatchTool);
  registry.register(fetchUrlTool);
  registry.register(downloadFileTool);
  registry.register(httpPostTool);
  registry.register(parseUrlTool);
  registry.register(extractPageLinksTool);
  registry.register(readCsvTool);
  registry.register(writeCsvTool);
  registry.register(csvStatsTool);
  registry.register(csvPreviewTool);
  registry.register(readJsonTool);
  registry.register(jsonKeysTool);
  registry.register(jsonTypeSummaryTool);
  registry.register(jsonMergeTool);
  registry.register(webSearchTool);
  registry.register(htmlToTextTool);
  registry.register(htmlLinksTool);
  registry.register(htmlMetadataTool);
  registry.register(htmlHeadingsTool);
  registry.register(markdownToHtmlTool);
  registry.register(markdownOutlineTool);
  registry.register(markdownLinksTool);
  registry.register(markdownCodeBlocksTool);
  registry.register(imageInfoTool);
  registry.register(imageBatchInfoTool);
  registry.register(imageAspectRatioTool);
  registry.register(imageDominantColorsTool);
  registry.register(imageTransparencyTool);
  registry.register(imageContentBoundsTool);
  registry.register(xmlToTextTool);
  registry.register(xmlSummaryTool);
  registry.register(xmlQueryTool);
  registry.register(iniParseTool);
  registry.register(propertiesParseTool);
  registry.register(tomlParseTool);
  registry.register(rtfToTextTool);
  registry.register(yamlParseTool);
  registry.register(yamlStringifyTool);
  registry.register(yamlQueryTool);
  registry.register(yamlKeysTool);
  registry.register(createZipTool);
  registry.register(listZipTool);
  registry.register(extractZipTool);
  registry.register(zipSummaryTool);
  // Filesystem extras
  registry.register(fileInfoTool);
  registry.register(makeDirTool);
  registry.register(copyFileTool);
  registry.register(deletePathTool);
  registry.register(findFilesTool);
  registry.register(countFilesTool);
  // Text utilities
  registry.register(wordCountTool);
  registry.register(headTailTool);
  registry.register(sortLinesTool);
  registry.register(replaceTextTool);
  registry.register(extractMatchesTool);
  registry.register(trimTextTool);
  registry.register(stripEmptyLinesTool);
  registry.register(dedupeLinesTool);
  registry.register(filterLinesTool);
  registry.register(textSliceTool);
  registry.register(extractBetweenTool);
  registry.register(textCaseTool);
  registry.register(reverseTextTool);
  registry.register(splitTextTool);
  registry.register(joinTextTool);
  registry.register(textFrequencyTool);
  registry.register(linePrefixTool);
  registry.register(lineSuffixTool);
  registry.register(textContainsTool);
  registry.register(textStartsWithTool);
  registry.register(textEndsWithTool);
  registry.register(textRepeatTool);
  registry.register(textTruncateTool);
  registry.register(textIndexOfTool);
  registry.register(charAtTool);
  registry.register(commonPrefixTextTool);
  registry.register(commonSuffixTextTool);
  registry.register(lineNumbersTool);
  registry.register(lineLengthsTool);
  registry.register(longestLineTool);
  registry.register(shortestLineTool);
  registry.register(firstNonemptyLineTool);
  registry.register(lastNonemptyLineTool);
  registry.register(countSubstringTool);
  registry.register(textEqualsTool);
  registry.register(textCompareTool);
  registry.register(textPadTool);
  registry.register(textWrapTool);
  registry.register(textUnwrapTool);
  registry.register(textRemovePrefixTool);
  registry.register(textRemoveSuffixTool);
  registry.register(nthLineTool);
  registry.register(takeLinesTool);
  registry.register(dropLinesTool);
  registry.register(lineContainsTool);
  registry.register(textSlugifyTool);
  registry.register(textSurroundTool);
  registry.register(textRepeatLinesTool);
  registry.register(textLengthTool);
  registry.register(textIsEmptyTool);
  // Encoding / hashing
  registry.register(base64EncodeTool);
  registry.register(base64DecodeTool);
  registry.register(hashTextTool);
  registry.register(urlEncodeTool);
  registry.register(urlDecodeTool);
  registry.register(uuidGenerateTool);
  // Number / compute / time
  registry.register(numberSumTool);
  registry.register(numberAverageTool);
  registry.register(numberMedianTool);
  registry.register(numberMinMaxTool);
  registry.register(numberStatsTool);
  registry.register(roundNumberTool);
  registry.register(clampNumberTool);
  registry.register(percentageOfTool);
  registry.register(sequenceGenerateTool);
  registry.register(baseConvertTool);
  registry.register(parseByteSizeTool);
  registry.register(formatDurationTool);
  registry.register(ratioSimplifyTool);
  registry.register(numberAbsTool);
  registry.register(numberSignTool);
  registry.register(numberCompareTool);
  registry.register(numberSortTool);
  registry.register(numberUniqueTool);
  registry.register(numberProductTool);
  registry.register(percentageChangeTool);
  registry.register(byteSizeFormatTool);
  registry.register(durationParseTool);
  registry.register(numberRangeCheckTool);
  registry.register(numberScaleTool);
  registry.register(numberModuloTool);
  registry.register(numberHistogramTool);
  registry.register(numberCumsumTool);
  registry.register(numberPercentileTool);
  registry.register(linearInterpolateTool);
  registry.register(currentDatetimeTool);
  registry.register(dateDiffTool);
  registry.register(calculateTool);
  // Path utilities
  registry.register(pathExistsTool);
  registry.register(pathNormalizeTool);
  registry.register(pathJoinTool);
  registry.register(pathRelativeTool);
  registry.register(pathDirnameTool);
  registry.register(pathBasenameTool);
  registry.register(pathExtnameTool);
  registry.register(pathPartsTool);
  registry.register(listDirsTool);
  registry.register(recentFilesTool);
  registry.register(largestFilesTool);
  registry.register(directorySummaryTool);
  registry.register(pathIsAbsoluteTool);
  registry.register(pathChangeExtTool);
  registry.register(pathAncestorsTool);
  registry.register(pathDepthTool);
  registry.register(pathCommonPrefixTool);
  registry.register(pathMatchesGlobTool);
  registry.register(fileExtensionsInDirTool);
  registry.register(emptyDirsTool);
  registry.register(siblingFilesTool);
  registry.register(duplicateFilenamesTool);
  registry.register(pathCompareTool);
  registry.register(pathStemTool);
  registry.register(pathParentTool);
  registry.register(hiddenFilesTool);
  registry.register(directoryDepthSummaryTool);
  registry.register(nearestAncestorWithTool);
  registry.register(filename_searchTool);
  // List utilities
  registry.register(listCountTool);
  registry.register(listUniqueTool);
  registry.register(listSortTool);
  registry.register(listReverseTool);
  registry.register(listSliceTool);
  registry.register(listChunkTool);
  registry.register(listUnionTool);
  registry.register(listIntersectTool);
  registry.register(listDiffTool);
  registry.register(listContainsTool);
  registry.register(listFrequencyTool);
  registry.register(listJoinTool);
  registry.register(listIndexOfTool);
  registry.register(listFlattenTool);
  registry.register(listZipTool2);
  // Multi-file + data conversion
  registry.register(readManyFilesTool);
  registry.register(globFilesTool);
  registry.register(diffFilesTool);
  registry.register(editLinesTool);
  registry.register(writeJsonTool);
  registry.register(formatJsonTool);
  registry.register(jsonToCsvTool);
  registry.register(csvToJsonTool);
  registry.register(listTreeTool);
  // System + line-level file access
  registry.register(readLinesTool);
  registry.register(appendFileTool);
  registry.register(envGetTool);
  registry.register(whichCommandTool);
  // Git write / network operations. Local staging tools are autoApprove so
  // auto mode can commit like CC. Network (fetch/pull) and history-shaping
  // (merge/cherry-pick/tag) stay behind the normal approval gate. Destructive
  // force-push / reset --hard / clean -f stay out of git-write.ts entirely.
  registry.register({ ...gitInitTool, autoApprove: true });
  registry.register({ ...gitAddTool, autoApprove: true });
  registry.register({ ...gitCommitTool, autoApprove: true });
  registry.register({ ...gitBranchTool, autoApprove: true });
  registry.register({ ...gitCheckoutTool, autoApprove: true });
  registry.register({ ...gitStashTool, autoApprove: true });
  registry.register(gitShowTool);
  registry.register(gitBlameTool);
  // fetch/pull/merge/cherry-pick/tag: autoApprove so auto mode can run them
  // (no path target). ask mode still confirms; deny mode still blocks.
  registry.register({ ...gitFetchTool, autoApprove: true });
  registry.register({ ...gitPullTool, autoApprove: true });
  registry.register({ ...gitMergeTool, autoApprove: true });
  registry.register({ ...gitCherryPickTool, autoApprove: true });
  registry.register({ ...gitTagTool, autoApprove: true });
  // git_reset (soft/mixed only) and git_restore both modify the working tree or
  // index and are recoverable in their safe variants, so auto mode may run them.
  // git_restore additionally marks its DESTRUCTIVE variant (staged=false, which
  // discards uncommitted edits) as `alwaysPrompt`, so that one always confirms
  // with the target list shown — autoApprove never applies to it.
  registry.register({ ...gitResetTool, autoApprove: true });
  registry.register({ ...gitRestoreTool, autoApprove: true });
  // Project ops / code quality
  registry.register(listScriptsTool);
  registry.register(runScriptTool);
  registry.register(installDepsTool);
  registry.register(typecheckTool);
  registry.register(runTestsTool);
  registry.register(lintTool);
  registry.register(dependencyTreeTool);
  registry.register(outdatedDepsTool);
  // Multi-agent: allow the main agent to spawn focused sub-agents in-process.
  // Sub-agents share the provider/workspace/approval context; depth-limited to
  // MAX_SUBAGENT_DEPTH to prevent unbounded recursion.
  registry.register(spawnSubAgentTool);
  // review_loop 静态基础版：保证可发现；root agent 启动后 replace 为 runtime 版。
  registry.register(reviewLoopBaseTool);
  // Excel COM automation: opt-in via the desktop computer-control switch.
  if (options?.excelAutomation) registry.register(excelAutomateTool);
  // 代码分析工具
  analysisTools.forEach((tool: any) => registry.register(tool));
  // 重构工具
  refactorTools.forEach((tool: any) => registry.register(tool));
  // AI 代码助手
  aiTools.forEach((tool: any) => registry.register(tool));
  // 测试工具
  testingTools.forEach((tool: any) => registry.register(tool));
  // 性能分析工具
  performanceTools.forEach((tool: any) => registry.register(tool));
  // 文档生成工具
  docTools.forEach((tool: any) => registry.register(tool));
  // 代码审计工具
  auditTools.forEach((tool: any) => registry.register(tool));
  // 代码生成工具
  codegenTools.forEach((tool: any) => registry.register(tool));
  // 工作流引擎工具
  workflowTools.forEach((tool: any) => registry.register(tool));
  // 代码质量门禁工具
  qualityTools.forEach((tool: any) => registry.register(tool));
  registry.register(qualityHistoryTool);        // Quality analysis history
  testTools.forEach((tool: any) => registry.register(tool));  // Test generation & fixing
  reviewTools.forEach((tool: any) => registry.register(tool)); // PR review & reviewer suggestion
  dependencyTools.forEach((tool: any) => registry.register(tool)); // Dependency freshness audit
  i18nTools.forEach((tool: any) => registry.register(tool));      // Hardcoded i18n text scan
  licenseTools.forEach((tool: any) => registry.register(tool));   // License compliance scan
  hotspotTools.forEach((tool: any) => registry.register(tool));   // Complexity hotspot report
  unusedExportTools.forEach((tool: any) => registry.register(tool)); // Unused export scan
  todoTools.forEach((tool: any) => registry.register(tool));        // Tracking comment report
  cycleTools.forEach((tool: any) => registry.register(tool));       // Import cycle detection
  conflictTools.forEach((tool: any) => registry.register(tool));    // Merge conflict prediction
  paramTools.forEach((tool: any) => registry.register(tool));       // Function signature report
  namingTools.forEach((tool: any) => registry.register(tool));      // Naming convention check
  unusedImportTools.forEach((tool: any) => registry.register(tool)); // Unused import scan
  eslintTools.forEach((tool: any) => registry.register(tool));       // ESLint config suggestion
  classMetricsTools.forEach((tool: any) => registry.register(tool)); // Class size metrics
  commentTools.forEach((tool: any) => registry.register(tool));     // Comment density report
  tsMigrationTools.forEach((tool: any) => registry.register(tool)); // JS to TS migration status
  dupDepsTools.forEach((tool: any) => registry.register(tool));     // Duplicate dep detection
  workspaceTools.forEach((tool: any) => registry.register(tool));   // Monorepo workspace tools
  packageDepsTools.forEach((tool: any) => registry.register(tool)); // Cross-package deps check
  workspaceGraphTools.forEach((tool: any) => registry.register(tool)); // Workspace dep graph export
  workspaceFilterTools.forEach((tool: any) => registry.register(tool)); // pnpm-style filter evaluation
  workspaceRunTools.forEach((tool: any) => registry.register(tool));   // Topo-ordered workspace script runner
  workspaceHistoryTools.forEach((tool: any) => registry.register(tool)); // Run history & diff
  unifiedPatchTools.forEach((tool: any) => registry.register(tool)); // Multi-file unified diff apply
  langStatsTools.forEach((tool: any) => registry.register(tool));     // Multi-language histogram
  gitQualityTools.forEach((tool: any) => registry.register(tool));    // Git commit quality report
  scaffoldTools.forEach((tool: any) => registry.register(tool));      // Project scaffolding
  openapiTools.forEach((tool: any) => registry.register(tool));       // OpenAPI to TypeScript types
  skillTools.forEach((tool: any) => registry.register(tool));         // Workspace skills (list/show)
  reflectionTools.forEach((tool: any) => registry.register(tool));   // Reflexion lessons (list/forget)
  lockfileTools.forEach((tool: any) => registry.register(tool));     // Lockfile diff analysis
  structureAuditTools.forEach((tool: any) => registry.register(tool)); // Structure health audit
  sessionAnalyticsTools.forEach((tool: any) => registry.register(tool)); // Session usage analytics
  prDescriptionTools.forEach((tool: any) => registry.register(tool));   // PR description generator
  commitAnalyzerTools.forEach((tool: any) => registry.register(tool));   // Git hotspot & coupling analysis
  memoryDigestTools.forEach((tool: any) => registry.register(tool));   // Memory digest (plan/apply)
  commitLintTools.forEach((tool: any) => registry.register(tool));     // Commit message linting
  reviewChecklistTools.forEach((tool: any) => registry.register(tool)); // Review checklist generator
  sessionTitleTools.forEach((tool: any) => registry.register(tool));      // Session title suggestion
  versionBumpTools.forEach((tool: any) => registry.register(tool));       // Version bump planner
  envContractTools.forEach((tool: any) => registry.register(tool));       // .env contract check
  // 文档生成（AST 签名提取版）：跳过与旧 docTools 同名的工具，避免重复注册
  for (const tool of docGenTools as any[]) {
    if (!registry.list().some((t: any) => t.name === (tool as any).name)) registry.register(tool);
  }
  // 智能代码建议工具
  suggestionTools.forEach((tool: any) => registry.register(tool));
  // 项目健康度仪表板工具
  healthTools.forEach((tool: any) => registry.register(tool));
  // 提示缓存健康诊断工具
  cacheHealthTools.forEach((tool: any) => registry.register(tool));
  return registry;
}

export { ToolRegistry } from './registry.js';
export type { ToolDefinition, ToolResult, ToolContext } from './types.js';
