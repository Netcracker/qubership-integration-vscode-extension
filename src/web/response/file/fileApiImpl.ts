import {FileApi} from './fileApi';
import {ExtensionContext, Uri} from 'vscode';
import * as yaml from 'yaml';
import {Chain, LibraryData} from "@netcracker/qip-ui";
import {EMPTY_USER} from "../chainApiUtils";
import {QipFileType} from "../serviceApiUtils";
import { FileFilter } from '../fileFilteringUtils';
import { getExtensionsForFile, extractFilename } from './fileExtensions';
import {Chain as ChainSchema} from "@netcracker/qip-schemas";
import { ContentParser } from '../../api-services/parsers/ContentParser';

const vscode = require('vscode');
const RESOURCES_FOLDER = 'resources';

export class VSCodeFileApi implements FileApi {
    context: ExtensionContext;

    constructor(context: ExtensionContext) {
        this.context = context;
    }

    private getExtensionsForContext(currentFileUri?: Uri) {
        if (currentFileUri) {
            return getExtensionsForFile(extractFilename(currentFileUri));
        }
        return getExtensionsForFile();
    }

    getRootDirectory(): Uri {
        return vscode.workspace.workspaceFolders[0].uri;
    }

    private async getParentDirectoryUri(uri: Uri): Promise<Uri> {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.File) {
                const lastSlashIndex = uri.path.lastIndexOf('/');
                const parentPath = lastSlashIndex > 0 ? uri.path.substring(0, lastSlashIndex) : uri.path;
                return uri.with({ path: parentPath });
            }
            return uri;
        } catch (_e) {
            // If stat fails (e.g., file doesn't exist yet), treat uri as a file path and return its parent
            const lastSlashIndex = uri.path.lastIndexOf('/');
            const parentPath = lastSlashIndex > 0 ? uri.path.substring(0, lastSlashIndex) : uri.path;
            return uri.with({ path: parentPath });
        }
    }

    private async getFilesByExtensionInDirectory(directoryUri: Uri, extension: string): Promise<string[]> {
        const entries = await readDirectory(directoryUri);
        return entries
            .filter(([, type]: [string, number]) => type === 1)
            .filter(([name]: [string, number]) => name.endsWith(extension))
            .map(([name]: [string, number]) => name);
    }

    private async getMainChainFileUri(baseUri: Uri): Promise<Uri> {
        if (!baseUri) {
            throw Error('No base uri provided');
        }
        const stat = await vscode.workspace.fs.stat(baseUri);
        if (stat.type === vscode.FileType.File) {
            return baseUri;
        }
        const extensions = this.getExtensionsForContext(baseUri);
        const files = await this.getFilesByExtensionInDirectory(baseUri, extensions.chain);
        if (files.length !== 1) {
            console.error(`Single *${extensions.chain} file not found in the current directory`);
            vscode.window.showWarningMessage(`*${extensions.chain} file not found in the current directory`);
            throw Error(`Single *${extensions.chain} file not found in the current directory`);
        }
        return vscode.Uri.joinPath(baseUri, files[0]);
    }

    async findAndBuildChainsRecursively(folderUri: Uri, chainBuilder: (chainContent: any) => Partial<Chain> | undefined, result: Partial<Chain>[]): Promise<void> {
        const entries = await readDirectory(folderUri);
        const extensions = this.getExtensionsForContext(folderUri);

        for (const [name, type] of entries) {
            if (type === vscode.FileType.File && name.endsWith(extensions.chain)) {
                const fileUri = vscode.Uri.joinPath(folderUri, name);

                const chainYaml = await this.parseFile(fileUri);
                const chain = chainBuilder(chainYaml);
                if (chain) {
                    result.push(chain);
                }
            } else if (type === vscode.FileType.Directory) {
                const subFolderUri = vscode.Uri.joinPath(folderUri, name);
                await this.findAndBuildChainsRecursively(subFolderUri, chainBuilder, result);
            }
        }
    }

    async findFileById(id: string, extension?: string): Promise<Uri> {
        if (extension) {
            return await this.findFile(extension, (fileContent: any) => {return fileContent?.id === id; });
        }

        const extensions = getExtensionsForFile();
        const typesToTry = [
            extensions.service,
            extensions.chain,
            extensions.specificationGroup,
            extensions.specification
        ];

        for (const ext of typesToTry) {
            try {
                return await this.findFile(ext, (fileContent: any) => {return fileContent?.id === id; });
            } catch (e) {
                continue;
            }
        }

        throw new Error(`File with id ${id} not found with any known extension`);
    }

    async findFile(extension: string, filterPredicate?: (fileContent: any) => boolean): Promise<Uri> {
        const result: Uri[] = [];
        const folderUri = this.getRootDirectory();

        await this.collectFiles(folderUri, {extension: extension, predicate: filterPredicate, findFirst: true}, result);

        if (result.length === 0) {
            throw Error(`Unable to find file with extension: ${extension}`);
        } else {
            return result[0];
        }
    }

    async findFiles(extension: string, filterPredicate?: (fileContent: any) => boolean): Promise<Uri[]> {
        const result: Uri[] = [];
        const folderUri = this.getRootDirectory();

        await this.collectFiles(folderUri, {extension: extension, predicate: filterPredicate, findFirst: false}, result);

        return result;
    }

    private async collectFiles(folderUri: Uri, fileFilter: FileFilter, result: Uri[]): Promise<void> {
        const entries = await readDirectory(folderUri);

        for (const [name, type] of entries) {
            if (type === vscode.FileType.File && name.endsWith(fileFilter.extension)) {
                const fileUri = vscode.Uri.joinPath(folderUri, name);
                const contentYaml = await this.parseFile(fileUri);
                if (!fileFilter.predicate || fileFilter.predicate(contentYaml)) {
                    result.push(fileUri);
                    if (fileFilter.findFirst) {
                        return;
                    }
                }
            } else if (type === vscode.FileType.Directory) {
                const subFolderUri = vscode.Uri.joinPath(folderUri, name);
                await this.collectFiles(subFolderUri, fileFilter, result);
            }
        }
    }

    async getMainChain(parameters: any): Promise<ChainSchema> {
        const baseUri = parameters as Uri;
        const fileUri = await this.getMainChainFileUri(baseUri);
        try {
            const parsed = await ContentParser.parseContentFromFile(fileUri);

            if (parsed && parsed.name) {
                return parsed;
            }
            throw Error('Invalid chain file content');
        } catch (e) {
            console.error(`Chain file ${fileUri} can't be parsed from QIP Extension API`, e);
            throw e;
        }
    }

    async readFile(parameters: any, propertiesFilename: string): Promise<string> {
        const baseUri = parameters as Uri;
        const baseFolder = await this.getParentDirectoryUri(baseUri);
        const fileUri = vscode.Uri.joinPath(baseFolder, propertiesFilename);
        let fileContent;
        try {
            fileContent = await this.readFileContent(fileUri);
        } catch (error) {
            if (!propertiesFilename.includes(RESOURCES_FOLDER)) {
                return await this.readFile(baseFolder, RESOURCES_FOLDER + '/' + propertiesFilename);
            }
            throw error;
        }
        return fileContent;
    }

    async parseFile(fileUri: Uri): Promise<any> {
        try {
            return await ContentParser.parseContentFromFile(fileUri);
        } catch (e) {
            console.error(`Unable to parse file: ${fileUri}`, e);
            throw e;
        }
    }

    async getLibrary(): Promise<LibraryData> {
        const fileUri = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'library.json');
        const content = await this.readFileContent(fileUri);
        return JSON.parse(content);
    }

    async writePropertyFile(parameters: any, propertyFilename: string, propertyData: string): Promise<void> {
        const baseUri = parameters as Uri;
        const baseFolder = await this.getParentDirectoryUri(baseUri);
        const bytes = new TextEncoder().encode(propertyData);
        try {
            await this.writeFile(vscode.Uri.joinPath(baseFolder, RESOURCES_FOLDER, propertyFilename), bytes);
            vscode.window.showInformationMessage('Property file has been updated!');
        } catch (err) {
            vscode.window.showErrorMessage('Failed to write file: ' + err);
            throw Error('Failed to write file: ' + err);
        }
    }

    async writeMainChain(parameters: any, chainData: ChainSchema): Promise<void> {
        const baseUri = parameters as Uri;
        const bytes = new TextEncoder().encode(yaml.stringify(chainData));
        try {
            await this.writeFile(await this.getMainChainFileUri(baseUri), bytes);
            vscode.window.showInformationMessage('Chain has been updated!');
        } catch (err) {
            vscode.window.showErrorMessage('Failed to write file: ' + err);
            throw Error('Failed to write file: ' + err);
        }
    }

    async removeFile(mainFolderUri: Uri, propertyFilename: string): Promise<void> {
        const baseFolder = await this.getParentDirectoryUri(mainFolderUri);
        const fileUri = vscode.Uri.joinPath(baseFolder, propertyFilename);
        try {
            await this.deleteFile(fileUri);
        } catch (error) {
            console.error("Error deleting property file", fileUri);
        }

        return;
    }


    // Service-related methods
    async getMainService(serviceFileUri: Uri): Promise<any> {
        try {
            const parsed = await ContentParser.parseContentFromFile(serviceFileUri);

            if (parsed && parsed.name) {
                return parsed;
            }
            throw Error('Invalid service file content');
        } catch (e) {
            console.error(`Service file ${serviceFileUri} can't be parsed from QIP Extension API`, e);
            throw e;
        }
    }

    async getService(serviceFileUri: Uri, serviceId: string): Promise<any> {
        try {
            const parsed = await ContentParser.parseContentFromFile(serviceFileUri);

            if (parsed && parsed.id === serviceId) {
                return parsed;
            }
            throw Error('Invalid service file content or service ID mismatch');
        } catch (e) {
            console.error(`Service file ${serviceFileUri} can't be parsed from QIP Extension API`, e);
            throw e;
        }
    }

    async writeMainService(serviceFileUri: Uri, serviceData: any): Promise<void> {
        await this.writeServiceFile(serviceFileUri, serviceData);
    }

    async writeServiceFile(fileUri: Uri, serviceData: any): Promise<void> {
        const yamlString = yaml.stringify(serviceData);
        const bytes = new TextEncoder().encode(yamlString);

        try {
            await this.writeFile(fileUri, bytes);
            vscode.window.showInformationMessage('Service has been updated!');
        } catch (err) {
            console.error('writeServiceFile: Error writing file:', err);
            vscode.window.showErrorMessage('Failed to write file: ' + err);
            throw Error('Failed to write file: ' + err);
        }
    }

    async createServiceDirectory(parameters: any, serviceId: string): Promise<Uri> {
        const mainFolderUri = parameters as Uri;
        const serviceFolderUri = vscode.Uri.joinPath(mainFolderUri, serviceId);
        await createDirectory(serviceFolderUri);
        return serviceFolderUri;
    }


    // Directory operations
    async readDirectory(parameters: any): Promise<[string, number][]> {
        const mainFolderUri = parameters as Uri;
        return await readDirectory(mainFolderUri);
    }

    async createDirectory(parameters: any, dirName: string): Promise<void> {
        const mainFolderUri = parameters as Uri;
        const dirUri = vscode.Uri.joinPath(mainFolderUri, dirName);
        await createDirectory(dirUri);
    }

    async createDirectoryByUri(dirUri: Uri): Promise<void> {
        await createDirectory(dirUri);
    }


    // File operations
    async writeFile(fileUri: Uri, data: Uint8Array): Promise<void> {
        const parentDir = await this.getParentDirectoryUri(fileUri);
        await createDirectory(parentDir);
        await vscode.workspace.fs.writeFile(fileUri, data);
    }

    async readFileContent(fileUri: Uri): Promise<string> {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        return new TextDecoder('utf-8').decode(bytes);
    }

    async deleteFile(fileUri: Uri): Promise<void> {
        const fileStat = await vscode.workspace.fs.stat(fileUri);
        if (fileStat.type === vscode.FileType.Directory) {
            const entries = await vscode.workspace.fs.readDirectory(fileUri);
            if (entries.length === 0) {
                await vscode.workspace.fs.delete(fileUri);
            } else {
                throw new Error(`Directory ${fileUri.fsPath} is not empty`);
            }
        } else {
            await vscode.workspace.fs.delete(fileUri);
        }
    }


    async createEmptyChain(createInParentDir: boolean = false): Promise<{ folderUri: Uri, chainId: string } | null> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('Open a workspace folder first');
                return null;
            }
            const arg = await vscode.window.showInputBox({ prompt: 'Enter new chain name' });

            let folderUri = workspaceFolders[0].uri;
            const chainId = crypto.randomUUID();
            const chainName = arg || 'New Chain';
            if (createInParentDir) {
                folderUri = vscode.Uri.joinPath(folderUri, '..');
            }
            folderUri = vscode.Uri.joinPath(folderUri, chainId);

            await createDirectory(folderUri);

            const extensions = this.getExtensionsForContext(folderUri);
            const chainFileUri = vscode.Uri.joinPath(folderUri, `${chainId}${extensions.chain}`);
            const chain = {
                $schema: 'http://qubership.org/schemas/product/qip/chain',
                id: chainId,
                name: chainName,
                content: { }
            };
            const bytes = new TextEncoder().encode(yaml.stringify(chain));

            await this.writeFile(chainFileUri, bytes);
            vscode.window.showInformationMessage(`Chain "${chainName}" created with id ${chainId}`);
            return { folderUri, chainId };
        } catch (err) {
            vscode.window.showErrorMessage(`Failed: ${err}`);
            return null;
        }
    }

    async createEmptyService(): Promise<{ folderUri: Uri, serviceId: string } | null> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('Open a workspace folder first');
                return null;
            }

            const serviceName = await vscode.window.showInputBox({
                prompt: 'Enter new service name',
                placeHolder: 'My Service',
                validateInput: (value: string) => {
                    if (!value || value.trim().length === 0) {
                        return 'Service name cannot be empty';
                    }
                    if (value.trim().length > 128) {
                        return 'Service name cannot be longer than 128 characters';
                    }
                    return null;
                }
            });

            if (!serviceName) {
                return null;
            }

            const serviceType = await vscode.window.showQuickPick([
                { label: 'External', value: 'EXTERNAL', description: 'External service' },
                { label: 'Internal', value: 'INTERNAL', description: 'Internal service' },
                { label: 'Implemented', value: 'IMPLEMENTED', description: 'Implemented service' }
            ], {
                placeHolder: 'Select service type',
                canPickMany: false
            });

            if (!serviceType) {
                return null;
            }

            const serviceDescription = await vscode.window.showInputBox({
                prompt: 'Enter service description (optional)',
                placeHolder: 'Description of the service',
                validateInput: (value: string) => {
                    if (value && value.trim().length > 512) {
                        return 'Description cannot be longer than 512 characters';
                    }
                    return null;
                }
            });

            const serviceId = crypto.randomUUID();
            const service = {
                $schema: 'http://qubership.org/schemas/product/qip/service',
                id: serviceId,
                name: serviceName.trim(),
                content: {
                    createdWhen: Date.now(),
                    modifiedWhen: Date.now(),
                    createdBy: { ...EMPTY_USER },
                    modifiedBy: { ...EMPTY_USER },
                    description: serviceDescription?.trim() || "",
                    activeEnvironmentId: "",
                    integrationSystemType: serviceType.value,
                    protocol: "",
                    extendedProtocol: "",
                    specification: "",
                    environments: [],
                    labels: [],
                    migrations: []
                }
            };

            // Create service file (folder will be created automatically)
            const serviceFolderUri = vscode.Uri.joinPath(workspaceFolders[0].uri, serviceId);
            const extensions = this.getExtensionsForContext(serviceFolderUri);
            const serviceFileUri = vscode.Uri.joinPath(serviceFolderUri, `${serviceId}${extensions.service}`);
            await this.writeServiceFile(serviceFileUri, service);

            vscode.window.showInformationMessage(`Service "${serviceName}" created successfully with type ${serviceType.label} in folder ${serviceId}`);
            return { folderUri: serviceFolderUri, serviceId };
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to create service: ${err}`);
            return null;
        }
    }

    async getFileType(fileUri: Uri): Promise<string> {
        try {
            const stat = await vscode.workspace.fs.stat(fileUri);
            const extensions = this.getExtensionsForContext(fileUri);

            if (stat.type === vscode.FileType.File) {
                const name = extractFilename(fileUri);
                if (name.endsWith(extensions.service)) {
                    return QipFileType.SERVICE;
                }
                if (name.endsWith(extensions.chain)) {
                    return QipFileType.CHAIN;
                }
                return QipFileType.UNKNOWN;
            }

            // Directory: infer by contents
            const entries = await this.readDirectoryInternal(fileUri);
            const hasChainFile = entries.some(([name]: [string, number]) => name.endsWith(extensions.chain));
            const hasServiceFile = entries.some(([name]: [string, number]) => name.endsWith(extensions.service));
            if (hasServiceFile) {
                return QipFileType.SERVICE;
            }
            if (hasChainFile) {
                return QipFileType.CHAIN;
            }
            return QipFileType.FOLDER;
        } catch (e) {
            return QipFileType.UNKNOWN;
        }
    }

    private async readDirectoryInternal(mainFolderUri: Uri): Promise<[string, number][]> {
        return await readDirectory(mainFolderUri);
    }

    private async getFilesByExtension(serviceFileUri: Uri, extension: string): Promise<string[]> {
        const serviceFolderUri = await this.getParentDirectoryUri(serviceFileUri);
        return await this.getFilesByExtensionInDirectory(serviceFolderUri, extension);
    }

    async getSpecificationGroupFiles(serviceFileUri: Uri): Promise<string[]> {
        const extensions = this.getExtensionsForContext(serviceFileUri);
        return await this.getFilesByExtension(serviceFileUri, extensions.specificationGroup);
    }

    async getSpecificationFiles(serviceFileUri: Uri): Promise<string[]> {
        const extensions = this.getExtensionsForContext(serviceFileUri);
        return await this.getFilesByExtension(serviceFileUri, extensions.specification);
    }

}

export async function readDirectory(mainFolderUri: Uri): Promise<[string, number][]> {
    return await vscode.workspace.fs.readDirectory(mainFolderUri);
}

export async function createDirectory(dirUri: Uri): Promise<void> {
    return await vscode.workspace.fs.createDirectory(dirUri);
}




