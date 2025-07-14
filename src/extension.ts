import * as vscode from 'vscode';
import { simpleGit, SimpleGit } from 'simple-git';

// 移除全局git实例
// let git;

// 添加输出通道用于日志
const outputChannel = vscode.window.createOutputChannel('Git快速合并');

/**
 * 获取当前活动工作区的Git实例
 */
function getCurrentWorkspaceGit(): SimpleGit | null {
    // 获取当前活动的文本编辑器
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return null;
    }

    // 获取当前文件所在的工作区
    const currentFileUri = activeEditor.document.uri;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentFileUri);
    
    if (!workspaceFolder) {
        return null;
    }

    // 为当前工作区创建Git实例
    return simpleGit(workspaceFolder.uri.fsPath);
}

/**
 * 获取当前工作区信息
 */
function getCurrentWorkspaceInfo(): { git: SimpleGit; workspacePath: string; workspaceName: string } | null {
    const git = getCurrentWorkspaceGit();
    if (!git) {
        return null;
    }

    const activeEditor = vscode.window.activeTextEditor;
    const currentFileUri = activeEditor!.document.uri;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentFileUri)!;

    return {
        git,
        workspacePath: workspaceFolder.uri.fsPath,
        workspaceName: workspaceFolder.name
    };
}

/**
 * 记录日志到输出通道和控制台
 */
function log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    
    outputChannel.appendLine(logMessage);
    
    switch (level) {
        case 'warn':
            console.warn(logMessage);
            break;
        case 'error':
            console.error(logMessage);
            break;
        default:
            console.log(logMessage);
    }
}

/**
 * 处理合并冲突的统一函数
 */
async function handleMergeConflict(
    git: SimpleGit, 
    currentBranch: string, 
    target: string, 
    conflictFiles: string[], 
    currentBranchStatus?: string
) {
    log(`处理合并冲突: 当前分支=${currentBranchStatus || target}, 冲突文件数=${conflictFiles.length}`, 'warn');
    
    const conflictMessage = `Git 合并冲突! | 当前分支: ${currentBranchStatus || target} | 冲突文件个数: ${conflictFiles.length}个`;

    // 显示冲突提示
    vscode.window.showErrorMessage(conflictMessage, "中止合并", "详细信息").then(async (selection) => {
    if (selection === "中止合并") {
        log('用户选择中止合并');
        try {
            await git.raw(['merge', '--abort']);
            await git.checkout(currentBranch);
            vscode.window.showInformationMessage(`已中止合并并切回分支: ${currentBranch}`);
            log(`成功中止合并并切回分支: ${currentBranch}`);
        } catch (abortError: any) {
            const errorMsg = `中止合并失败: ${abortError.message}`;
            vscode.window.showErrorMessage(errorMsg);
            log(errorMsg, 'error');
        }
    } else if (selection === "详细信息") {
        log('用户查看冲突详细信息');
        const detailModalContent = `\n## 冲突文件列表:\n${conflictFiles.length > 0 ? conflictFiles.map(file => `- ${file}`).join('\n') : '• 请查看VSCode资源管理器中的红色标记文件'}\n\n## 解决方案:\n1. 手动解决冲突:\n   - 编辑冲突文件解决冲突后手动commit\n\n2. 放弃合并: \n   - \`git merge --abort\``;
            vscode.window.showInformationMessage("Git 合并冲突详细信息", { modal: true, detail: detailModalContent });
        }
    });
}

export function activate(context: vscode.ExtensionContext) {
    log('Git快速合并插件已激活');
    
    // 移除全局git初始化
    // if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    //     const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    //     git = simpleGit(workspaceRoot);
    // }

    // 注册命令：合并到目标分支
    const mergeCommand = vscode.commands.registerCommand('gitMergeIntoTarget.mergeToTarget', async () => {
        await mergeToTargetBranch();
    });

    context.subscriptions.push(mergeCommand);

    // 注册命令：一键更新所有本地分支
    const updateAllBranchesCommand = vscode.commands.registerCommand('gitMergeIntoTarget.updateAllBranches', async () => {
        await updateAllBranches();
    });
    context.subscriptions.push(updateAllBranchesCommand);
}

/**
 * 主要的合并功能
 */
async function mergeToTargetBranch() {
    // 获取当前工作区信息
    const workspaceInfo = getCurrentWorkspaceInfo();
    if (!workspaceInfo) {
        vscode.window.showErrorMessage('无法获取当前工作区的Git信息，请确保当前文件在Git仓库中');
        return;
    }

    const { git, workspacePath, workspaceName } = workspaceInfo;
    
    // 验证是否为Git仓库
    try {
        await git.status();
    } catch (error) {
        vscode.window.showErrorMessage(`当前工作区 "${workspaceName}" 不是Git仓库`);
        return;
    }

    let stashed = false;
    try {
        // 检查工作区状态
        const status = await git.status();
        // 只在有已追踪文件更改时弹窗，untracked 文件不弹窗
        const hasTrackedChanges = status.staged.length > 0 || status.modified.length > 0 || status.conflicted.length > 0;
        if (hasTrackedChanges) {
            const answer = await vscode.window.showWarningMessage(
                `工作区 "${workspaceName}" 有未提交的更改。`,
                { modal: true },
                '立即暂存',
                '继续合并'
            );
            if (answer === '立即暂存') {
                await git.stash();
                stashed = true;
                vscode.window.showInformationMessage('更改已暂存');
            } else if (answer !== '继续合并') {
                return;
            }
        }

        // 获取当前分支
        const currentBranch = (await git.branch()).current;
        if (!currentBranch) {
            vscode.window.showErrorMessage('无法获取当前分支');
            return;
        }

        // 获取并选择远程仓库
        const remotes = await git.getRemotes(true);
        let remoteName: string;

        if (remotes.length === 0) {
            vscode.window.showErrorMessage('没有找到远程仓库');
            return;
        } else if (remotes.length === 1) {
            remoteName = remotes[0].name;
        } else {
            const selectedRemote = await vscode.window.showQuickPick(
                remotes.map(r => ({ label: r.name, description: r.refs.fetch })),
                { title: '选择远程仓库' }
            );
            if (!selectedRemote) {
                return; // 用户取消选择
            }
            remoteName = selectedRemote.label;
        }

        // 直接选择目标分支
        let targetBranch: string | undefined;
        
        try {
            // 获取所有本地分支
            const branches = await git.branchLocal();
            const branchList = branches.all;
            
            // 去重并过滤当前分支和HEAD
            const uniqueBranches = [...new Set(branchList)]
                .filter(branch => !branch.includes('HEAD') && branch !== currentBranch);
            
            if (uniqueBranches.length === 0) {
                vscode.window.showErrorMessage('没有找到其他可用分支');
                return;
            }

            // 按字母顺序排序分支
            const sortedBranches = uniqueBranches.sort((a, b) => a.localeCompare(b));

            // 创建简洁的分支选项，包含工作区信息
            const branchItems = sortedBranches.map(branch => ({
                label: `$(git-branch) ${branch}`,
                description: `[${workspaceName}] 将 "${currentBranch}" 合并到 "${branch}"`,
                branch: branch
            }));

            const selected = await vscode.window.showQuickPick(branchItems, {
                title: `Git 快速合并 - ${workspaceName}`,
                placeHolder: `选择目标分支即可开始合并 (当前分支: ${currentBranch})`,
                matchOnDescription: true
            });

            if (!selected) {
                return; // 用户取消了选择
            }

            targetBranch = selected.branch;

        } catch (error) {
            vscode.window.showErrorMessage(`获取分支列表失败: ${error}`);
            return;
        }

        // 显示进度条
        let mergeResult = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `正在执行Git合并操作... (${workspaceName})`,
            cancellable: false
        }, async (progress) => {
            // 在这里明确类型，确保 targetBranch 是字符串
            const target: string = targetBranch!;
            try {
                // 步骤1: 切换到目标分支
                progress.report({ increment: 15, message: `切换到目标分支 ${target}...` });
                try {
                    await git.checkout(target);
                } catch (checkoutError: any) {
                    throw new Error(`切换到目标分支失败: ${checkoutError.message}`);
                }

                // 步骤2: 拉取远程更新
                progress.report({ increment: 20, message: '拉取远程更新...' });
                try {
                    await git.pull(remoteName, target);
                } catch (pullError: any) {
                    // 检查是否是上游分支未设置的错误
                    if (pullError.message?.includes('no tracking information') || 
                        pullError.message?.includes('There is no tracking information')) {
                        
                        // 尝试设置上游分支并重新拉取
                        const answer = await vscode.window.showWarningMessage(
                            `分支 "${target}" 没有设置上游分支。是否设置上游分支为 ${remoteName}/${target} 并继续？`,
                            '设置并继续',
                            '跳过拉取',
                            '取消操作'
                        );
                        
                        if (answer === '设置并继续') {
                            try {
                                await git.push(['--set-upstream', remoteName, target]);
                                await git.pull(remoteName, target);
                                vscode.window.showInformationMessage(`已设置上游分支 ${remoteName}/${target}`);
                            } catch (upstreamError: any) {
                                vscode.window.showWarningMessage(`设置上游分支失败，跳过拉取步骤: ${upstreamError.message}`);
                            }
                        } else if (answer === '跳过拉取') {
                            vscode.window.showWarningMessage('跳过了远程拉取步骤，继续合并...');
                        } else {
                            throw new Error('用户取消了操作');
                        }
                    }
                     else {
                        throw new Error(`拉取远程更新失败: ${pullError.message}`);
                    }
                }

                // 步骤3: 合并当前分支
                progress.report({ increment: 30, message: `合并分支 ${currentBranch}...` });
                let mergeSuccess = false;
                try {
                    await git.merge([currentBranch]);
                    mergeSuccess = true;
                } catch (mergeError: any) {
                    log('Merge error details: ' + mergeError.message, 'error');
                    // 检查是否是合并冲突 - 更全面的检测
                    const errorMsg = mergeError.message?.toLowerCase() || '';
                    const isConflict = errorMsg.includes('conflict') || 
                                     errorMsg.includes('automatic merge failed') ||
                                     errorMsg.includes('merge conflict') ||
                                     errorMsg.includes('needs merge') ||
                                     mergeError.git?.conflicts?.length > 0;
                    
                    if (isConflict) {
                        // 获取当前分支状态和冲突文件
                        let currentBranchStatus = target;
                        let conflictFiles: string[] = [];
                        
                        try {
                            const status = await git.status();
                            currentBranchStatus = status.current || target;
                            conflictFiles = status.conflicted || [];
                        } catch (statusError) {
                            log('获取状态失败: ' + statusError, 'error');
                        }

                        // 使用统一的冲突处理函数
                        await handleMergeConflict(git, currentBranch, target, conflictFiles, currentBranchStatus);
                        
                        // 返回特殊标识，表示合并冲突
                        return { success: false, conflict: true };
                    } else {
                        throw new Error(`合并失败: ${mergeError.message}`);
                    }
                }

                // 检查Git状态，确认是否真的合并成功
                if (mergeSuccess) {
                    try {
                        const status = await git.status();
                        // 如果有冲突文件，说明合并实际上失败了
                        if (status.conflicted && status.conflicted.length > 0) {
                            log('发现冲突文件，尽管merge命令没有报错', 'warn');
                            
                            // 使用统一的冲突处理函数
                            await handleMergeConflict(git, currentBranch, target, status.conflicted, status.current || target);
                            
                            return { success: false, conflict: true };
                        }
                    }
                     catch (statusError) {
                        log('检查Git状态失败: ' + statusError, 'error');
                    }
                }
                
                // 只有合并成功才继续后续步骤
                if (!mergeSuccess) {
                    return { success: false, conflict: false, error: '合并步骤失败' };
                }

                // 步骤4: 推送到远程
                progress.report({ increment: 20, message: '推送到远程仓库...' });
                try {
                    await git.push(remoteName, target);
                } catch (pushError: any) {
                    throw new Error(`推送到远程失败: ${pushError.message}`);
                }

                // 步骤5: 切回原分支
                progress.report({ increment: 15, message: `切回原分支 ${currentBranch}...` });
                try {
                    await git.checkout(currentBranch);
                } catch (checkoutBackError: any) {
                    vscode.window.showWarningMessage(`切回原分支失败: ${checkoutBackError.message}，请手动切换到 ${currentBranch}`);
                }

                vscode.window.showInformationMessage(
                    `✅ 成功将 "${currentBranch}" 合并到 "${target}" 并推送到远程！ (${workspaceName})`
                );

                // 返回成功标识
                return { success: true, conflict: false };

            } catch (error: any) {
                // 通用错误处理：确保能切回原分支
                
                // 检查当前分支
                try {
                    const currentStatus = await git.branch();
                    if (currentStatus.current !== currentBranch) {
                        // 只有当前不在原分支时才尝试切回
                        try {
                            await git.checkout(currentBranch);
                            vscode.window.showInformationMessage(`已切回原分支: ${currentBranch}`);
                        } catch (checkoutError: any) {
                            vscode.window.showWarningMessage(`自动切回原分支失败，请手动执行: git checkout ${currentBranch}`);
                        }
                    }
                }
                 catch (statusError) {
                    log('检查分支状态失败: ' + statusError, 'error');
                }

                // 显示错误信息
                const errorMessage = error.message || '合并操作失败';
                vscode.window.showErrorMessage(errorMessage);
                log('Git merge error: ' + error.message, 'error');
                
                // 返回错误标识
                return { success: false, conflict: false, error: errorMessage };
            }
        });

        // 根据结果决定后续操作
        if (!mergeResult) {
            // 进度操作被取消或出现未知错误
            return;
        }

        if (mergeResult.conflict) {
            // 合并冲突，不显示成功信息，也不尝试切换分支
            log('合并冲突，保持在目标分支等待用户处理', 'warn');
            return;
        }

        if (!mergeResult.success && mergeResult.error) {
            // 其他错误，已经在进度条中处理过了
            return;
        }

    } catch (error: any) {
        vscode.window.showErrorMessage(`操作失败: ${error.message || error}`);
        log('Git operation error: ' + error.message, 'error');
    } finally {
        if (stashed) {
            try {
                await git.stash(['pop']);
                vscode.window.showInformationMessage('已恢复之前暂存的更改');
            } catch (stashError: any) {
                vscode.window.showWarningMessage(`恢复暂存失败: ${stashError.message}`);
            }
        }
    }
}

/**
 * 一键更新本地所有分支
 */
async function updateAllBranches() {
    const workspaceInfo = getCurrentWorkspaceInfo();
    if (!workspaceInfo) {
        vscode.window.showErrorMessage('无法获取当前工作区的Git信息，请确保当前文件在Git仓库中');
        return;
    }
    const { git, workspaceName } = workspaceInfo;
    let currentBranch = '';
    const failedBranches: string[] = [];
    try {
        // 获取所有本地分支
        const branches = await git.branchLocal();
        const branchList = branches.all.filter(b => !b.includes('HEAD'));
        if (branchList.length === 0) {
            vscode.window.showWarningMessage('没有本地分支可更新');
            return;
        }
        // 记录当前分支
        currentBranch = branches.current;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `正在更新所有本地分支... (${workspaceName})`,
            cancellable: false
        }, async (progress) => {
            let done = 0;
            for (const branch of branchList) {
                progress.report({ increment: (100 / branchList.length), message: `切换并拉取 ${branch}...` });
                try {
                    await git.checkout(branch);
                    await git.pull();
                } catch (err: any) {
                    log(`分支 ${branch} 更新失败: ${err.message}`, 'warn');
                    failedBranches.push(branch);
                }
                done++;
            }
        });
    } catch (err: any) {
        vscode.window.showErrorMessage(`更新分支时发生错误: ${err.message}`);
        return;
    } finally {
        // 切回原分支
        if (currentBranch) {
            try {
                await git.checkout(currentBranch);
            } catch {}
        }
    }
    // 汇总结果
    if (failedBranches.length > 0) {
        const msg = `以下分支更新失败：\n${failedBranches.join(', ')}`;
        vscode.window.showInformationMessage(msg, { modal: true });
    }
}

export function deactivate() {
    log('Git快速合并插件已停用');
    outputChannel.dispose();
}