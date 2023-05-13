import getUuid from '@/server/utils/uuid';
import cron from 'node-cron';
import { logger } from '../utils/logger';
import { ReademGithubCompany, ReademGithubProject } from '@/types/index.type';
import { queryPrismaDb } from '../db/prisma';
import { isDateOlderThanDays } from '../utils/isDateOld';

class ActiveMemoryStore {
  private static instance: ActiveMemoryStore | null = null;
  private fileStore: { [key: string]: any } = {};
  private lastUpdated = new Date();

  public static getInstance(): ActiveMemoryStore {
    if (!ActiveMemoryStore.instance) {
      ActiveMemoryStore.instance = new ActiveMemoryStore();
    }

    return ActiveMemoryStore.instance;
  }

  public getData(key: string) {
    return this.fileStore[key];
  }
  public setData(key: string, value: any) {
    this.lastUpdated = new Date();
    this.fileStore[key] = value;
  }

  public getLastUpdated(): Date {
    return this.lastUpdated;
  }
}

export const fileStorage = ActiveMemoryStore.getInstance();
export class GetDataCronSingleton {
  private static instance: GetDataCronSingleton | null = null;
  private cronJob;

  private constructor() {
    // Start job
    if (!this.cronJob) {
      this.cronJob = cron.schedule('0 0 */3 * * *', () => this.populateData());
    }
    this.populateData();
  }

  public static getInstance(): GetDataCronSingleton {
    if (!GetDataCronSingleton.instance) {
      GetDataCronSingleton.instance = new GetDataCronSingleton();
    }

    return GetDataCronSingleton.instance;
  }

  public async populateData(): Promise<void> {
    try {
      await mainDataFetch();
    } catch (error) {
      logger.error(
        '🚀 ~ file: githubMdParser.ts:235 ~ CronSingleTon ~ getData ~ error:',
        error
      );
    }
  }
}

export const JSON_DATA_STORE_KEY = 'jsonData';
export const COMPANIES_STORE_KEY = 'companies';
export const PROJECTS_STORE_KEY = 'projects';

const langsToListRegex = /^\s?#{3}([^#{3}]+?)\n([^]+?)(?=^\s?#{3}[^#{3}])/gm;
const splitProjectRegex = /\[(.+)\]\((.+)\) - (.+)/;
const splitCompanyRegex = /\[(.+)\]\((.+)\)/;
const cleanBadgesRegex = /!\[(.+)\]\(.+\)/;
const findListItemRegex = /(?<=\* ).*/gm;
const projectsTitleRegex =
  /(?:^|\n)## Projects by main language\s?[^\n]*\n(.*?)(?=\n##?\s|$)/gs;
const compsTitleRegex = /(?:^|\n)## Companies\s?[^\n]*\n(.*?)(?=\n##?\s|$)/gs;

const headersList = {
  Accept: '*/*',
  Authorization: 'bearer ' + process.env.github_read_only,
  'Content-Type': 'application/json'
};

export function githubMdParser(rawReadmeFile: string) {
  try {
    const allProjects: string[] = [];
    const allComps: string[] = [];

    const compsStr = (rawReadmeFile.match(compsTitleRegex) as string[])[0];
    const langsStr = (rawReadmeFile.match(projectsTitleRegex) as string[])[0];

    const compsList = compsStr.match(findListItemRegex);
    const allLanguages = langsStr.match(langsToListRegex);

    compsList?.forEach((company) => {
      allComps.push(company.match(splitCompanyRegex) as unknown as string);
    });

    allLanguages?.forEach((lang) => {
      allProjects.push(lang.match(findListItemRegex) as unknown as string);
    });

    const parsedAllComps = allComps
      .map((company: string) => {
        if (company[2].split('/').includes('github.com')) {
          return { name: company[2].replace('https://github.com/', '') };
        }
      })
      .filter(
        (company: ReademGithubCompany | undefined) => company != undefined
      );

    const parsedAllProjects = allProjects
      .flat()
      .map((projectStr: string) => {
        const res = projectStr.match(splitProjectRegex);

        // Checking if rawReadmeFile exists and if it is a GitHub url
        if (res && res[2].split('/').includes('github.com')) {
          // Checking if rawReadmeFile is a repo. Else, add to companies
          if (res[2].split('/').length > 4) {
            const name = res[2].replace('https://github.com/', '');
            return {
              name: name,
              description: res[3].replace(cleanBadgesRegex, '')
            };
          } else {
            parsedAllComps.push({ name: res[2].split('/')[3] });
          }
        }
      })
      .filter(
        (project: ReademGithubProject | undefined) => project != undefined
      );

    return {
      success: true,
      allComps: parsedAllComps as unknown as ReademGithubCompany[],
      allProjects: parsedAllProjects as unknown as ReademGithubProject[],
      allLanguages
    };
  } catch (error) {
    logger.error(
      '🚀 ~ file: githubMdParser.ts:5 ~ githubMdParser ~ error:',
      error
    );
    return { success: false, allComps: [], allProjects: [], allLanguages: [] };
  }
}

export async function fetchGithubMd() {
  'use server';
  const readmeUrl =
    'https://raw.githubusercontent.com/lirantal/awesome-opensource-israel/master/README.md';

  try {
    const repsonse = await fetch(readmeUrl).then((res) => res.text());
    return repsonse;
  } catch (error) {
    logger.error(
      '🚀 ~ file: githubMdParser.ts:93 ~ fetchGithubMd ~ error:',
      error
    );

    return null;
  }
}

export async function fetchProjects(
  allProjects: { name: string; description: string }[]
) {
  const requests: any[] = [];
  const results: any[] = [];

  allProjects.forEach((project: { name: string; description: string }) => {
    requests.push(getProject(project));
  });
  return new Promise((resolve) => {
    Promise.all(requests)
      .then((proms) => proms.forEach((p) => results.push(p.data)))
      .then(() => resolve(results));
  });
}

async function getCompany(company: { name: string }) {
  const gqlBody: { query: string; variables: { login: string } } = {
    query: `query ($login: String!) {
    organization(login: $login) {
      name
      avatarUrl
      login
      repositories(
        first: 100
        isLocked: false
        isFork: false
        privacy: PUBLIC
        orderBy: {direction: DESC, field: STARGAZERS}
      ) {
        nodes {
          openIssues: issues(states:OPEN) {
            totalCount
          }
          stargazerCount
          nameWithOwner
          languages(first: 3, orderBy: {field: SIZE, direction: DESC}) {
            totalSize
            edges {
              size
              node {
                name
              }
            }
          }
          openGraphImageUrl
          description
          defaultBranchRef {
            target {
              ... on Commit {
                committedDate
              }
            }
          }
        }
      }
    }
  }`,
    variables: { login: company.name }
  };

  return await fetch('https://api.github.com/graphql', {
    method: 'POST',
    mode: 'cors',
    headers: headersList,
    body: JSON.stringify(gqlBody)
  }).then((res) => res.json());
}

async function getProject(project: { name: string }) {
  const gqlBody = {
    query: `query ($repoOwner: String!, $repoName: String!) {
    repository(owner: $repoOwner, name: $repoName) {
      openIssues: issues(states:OPEN) {
        totalCount
      }
      stargazerCount
      nameWithOwner
      languages(first: 3, orderBy: {field: SIZE, direction: DESC}) {
        totalSize
        edges {
          size
          node {
            name
          }
        }
      }
      openGraphImageUrl
      description
      defaultBranchRef {
        target {
          ... on Commit {
            committedDate
          }
        }
      }
    }
  }
  `,
    variables: {
      repoOwner: project.name.split('/')[0],
      repoName: project.name.split('/')[1]
    }
  };

  return await fetch('https://api.github.com/graphql', {
    method: 'POST',
    mode: 'cors',
    headers: headersList,
    body: JSON.stringify(gqlBody)
  }).then((res) => res.json());
}

export async function fetchComps(allComps: { name: string }[]) {
  const requests: any[] = [];
  const results: any[] = [];

  allComps.forEach((company: { name: string }) => {
    requests.push(getCompany(company));
  });
  return new Promise((resolve) => {
    Promise.all(requests)
      .then((proms) => proms.forEach((p) => results.push(p.data)))
      .then(() => resolve(results));
  });
}

async function storeFiles(data: {
  success: boolean;
  allComps: ReademGithubCompany[];
  allGqlProjects: ReademGithubProject[];
  allGqlCompanies: unknown[];
  allLanguages: string[];
}) {
  return await queryPrismaDb('fileStore', 'create', {
    data: {
      filename: 'JSON' + Date.now(),
      file: JSON.stringify(data)
    }
  });
}

export async function mainDataFetch() {
  try {
    logger.info(
      Date.now(),
      getUuid,
      'Initiating search for existing store in memory...'
    );

    const data = fileStorage.getData(JSON_DATA_STORE_KEY);
    const projects = fileStorage.getData(PROJECTS_STORE_KEY);
    const companies = fileStorage.getData(COMPANIES_STORE_KEY);
    if (
      data &&
      projects &&
      companies &&
      !isDateOlderThanDays(fileStorage.getLastUpdated(), 3)
    ) {
      logger.info(Date.now(), 'Fetching from memory...');
      return { success: true, data, projects, companies };
    }

    logger.info(Date.now(), 'Fetching from github...');
    const result = await fetchGithubMd();
    if (!result) {
      throw new Error('Failed to fetch from github readme!');
    }
    const { success, allComps, allLanguages, allProjects } =
      githubMdParser(result);
    if (
      !success ||
      !allComps.length ||
      !allLanguages?.length ||
      !allProjects.length
    ) {
      throw new Error('Error parsing readme from github');
    }

    const allGqlCompanies: any = await fetchComps(allComps);
    if (!allGqlCompanies.length) {
      throw new Error('Error fetching GQL companies');
    }
    const allGqlProjects: any = await fetchProjects(allProjects);
    if (!allGqlProjects.length) {
      throw new Error('Error fetching GQL projects');
    }
    const dbStoreResult = await storeFiles({
      success,
      allComps,
      allGqlProjects,
      allGqlCompanies,
      allLanguages
    });
    if (!dbStoreResult?.id || !dbStoreResult?.file) {
      throw new Error('store in db failed!');
    }

    logger.info(Date.now(), 'Setting to memory...');
    fileStorage.setData(JSON_DATA_STORE_KEY, dbStoreResult);
    fileStorage.setData(PROJECTS_STORE_KEY, allGqlProjects);
    fileStorage.setData(COMPANIES_STORE_KEY, allGqlCompanies);
    const storedFileData = fileStorage.getData(JSON_DATA_STORE_KEY);
    return {
      success,
      allComps,
      projects: allGqlProjects,
      companies: allGqlCompanies,
      allLanguages,
      dbStoreResult,
      storedFileData
    };
  } catch (error) {
    logger.error(
      '🚀 ~ file: githubMdParser.ts:235 ~ CronSingleTon ~ getData ~ error:',
      error
    );
  }
}

export async function fetchCompany(companyId: string) {
  try {
    await mainDataFetch();
    const companies = fileStorage.getData(COMPANIES_STORE_KEY);
    const target = companies.find(
      (company: any) => company?.organization?.login === companyId
    );
    return target !== -1 ? target : null;
  } catch (error) {
    logger.error(
      '🚀 ~ file: dataManager.service.ts:397 ~ fetchCompany ~ error:',
      error
    );
  }
}

export async function fetchAllCompanies() {
  try {
    await mainDataFetch();
    return fileStorage.getData(COMPANIES_STORE_KEY);
  } catch (error) {
    logger.error(
      '🚀 ~ file: dataManager.service.ts:416 ~ fetchAllCompanies ~ error:',
      error
    );
  }
}

export async function fetchAllRepositories() {
  try {
    await mainDataFetch();
    return fileStorage.getData(PROJECTS_STORE_KEY);
  } catch (error) {
    logger.error(
      '🚀 ~ file: dataManager.service.ts:429 ~ fetchAllRepositories ~ error:',
      error
    );
  }
}
