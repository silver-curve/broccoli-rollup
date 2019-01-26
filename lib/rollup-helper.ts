import { InputOptions, OutputOptions, rollup, RollupCache } from 'rollup';
import Dependencies from './dependencies';
import { heimdall } from './heimdall';
import {
  Change,
  syncFiles,
  Tree,
  treeFromEntries,
  treeFromPath,
} from './utils';

export default class RollupHelper {
  private dependencies: Dependencies;
  private digests = new Map<string, string>();
  private lastBuildTree = undefined as Tree | undefined;
  private lastBuildStale = true;
  private cache = undefined as RollupCache | undefined;

  constructor(
    public inputPath: string,
    public buildPath: string,
    public outputPath: string,
    public inputOptions: InputOptions,
    public outputOptions: OutputOptions[],
    public shouldCache: boolean,
  ) {
    this.dependencies = new Dependencies(buildPath);
  }

  public async build() {
    const inputTree = this.syncInput();

    // no changes
    if (inputTree === undefined) {
      return;
    }

    const outputTree = await this.rollup(inputTree);

    this.syncOutput(outputTree);
  }

  private syncInput(): Tree | undefined {
    const token = heimdall.start('syncInput');
    try {
      const inputPath = this.inputPath;
      const buildPath = this.buildPath;

      const inputTree = treeFromPath(inputPath);

      const lastBuildTree = this.lastBuildTree;

      let inputChanges: Change[] | undefined;
      if (lastBuildTree !== undefined) {
        inputChanges = lastBuildTree.calculatePatch(inputTree);

        if (!this.dependencies.shouldBuild(inputChanges)) {
          return;
        }
      }

      if (inputChanges === undefined || this.lastBuildStale) {
        // need to use current state of buildPath
        inputChanges = treeFromPath(buildPath).calculatePatch(inputTree);
      }

      syncFiles(inputPath, buildPath, inputChanges);

      return inputTree;
    } finally {
      token.stop();
    }
  }

  private async rollup(inputTree: Tree) {
    const token = heimdall.start('rollup');
    try {
      const options = this.inputOptions;
      options.cache = this.cache;

      const build = await rollup(options);

      if (this.shouldCache) {
        this.cache = build.cache;
      }

      for (const outputOptions of this.outputOptions) {
        await build.write(outputOptions);
      }

      const buildTree = treeFromPath(this.buildPath);
      const outputTree = calculateOutputTree(inputTree, buildTree);

      // used to check input on next build
      this.dependencies.add(build);
      this.lastBuildTree = buildTree;
      this.lastBuildStale = false;

      return outputTree;
    } catch (e) {
      this.lastBuildStale = true;
      throw e;
    } finally {
      token.stop();
    }
  }

  private syncOutput(outputTree: Tree) {
    const token = heimdall.start('syncOutput');
    try {
      const outputPath = this.outputPath;
      const outputChanges = treeFromPath(outputPath).calculatePatch(outputTree);
      syncFiles(this.buildPath, outputPath, outputChanges, this.digests);
    } finally {
      token.stop();
    }
  }
}

function calculateOutputTree(inputTree: Tree, buildTree: Tree): Tree {
  const buildDiff = inputTree.calculatePatch(buildTree);
  const outputEntries = buildDiff
    .filter(change => change[0] === 'create')
    .map(change => change[2]);

  return treeFromEntries(outputEntries, {
    sortAndExpand: true,
  });
}