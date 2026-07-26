// Chinese and English skill dictionary for matching
// Organized by industry category
export const SKILL_CATEGORIES: Record<string, string[]> = {
  '前端开发': ['React', 'Vue', 'Angular', 'JavaScript', 'TypeScript', 'HTML', 'CSS', 'Webpack', 'Vite', 'Next.js', 'Nuxt.js', 'Svelte', 'jQuery', 'Bootstrap', 'Sass/Less', '小程序开发'],
  '后端开发': ['Java', 'Spring', 'Spring Boot', 'Python', 'Django', 'Flask', 'Go', 'Node.js', 'Express', 'NestJS', 'PHP', 'Laravel', 'C#', '.NET', 'Ruby', 'Rails', 'RESTful API', 'GraphQL'],
  '移动开发': ['Swift', 'Kotlin', 'Flutter', 'React Native', 'iOS', 'Android', 'Dart', 'Objective-C'],
  '数据科学': ['Python', 'SQL', 'Pandas', 'NumPy', 'Spark', 'Hadoop', 'R', 'Tableau', 'Power BI', '数据仓库', 'ETL'],
  'AI/机器学习': ['TensorFlow', 'PyTorch', 'Keras', '机器学习', '深度学习', 'NLP', '计算机视觉', 'LLM', 'RAG', 'Scikit-learn'],
  '运维/DevOps': ['Docker', 'Kubernetes', 'Jenkins', 'AWS', 'Azure', 'GCP', 'Terraform', 'Ansible', 'Linux', 'Nginx', 'CI/CD', 'Prometheus', 'Grafana'],
  '数据库': ['MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'Elasticsearch', 'Oracle', 'SQLite', 'Cassandra', 'ClickHouse'],
  '测试': ['Selenium', 'Jest', 'JUnit', 'Pytest', 'Postman', 'JMeter', '自动化测试', '性能测试', '单元测试', '集成测试'],
  '产品/设计': ['Figma', 'Sketch', 'Adobe XD', 'Axure', '产品设计', '交互设计', 'UX', 'UI', '用户研究', '需求分析', 'PRD'],
  '项目管理': ['Scrum', '敏捷开发', 'Jira', 'Confluence', '项目管理', '团队管理', '风险管理', 'OKR', 'KPI'],
  '市场营销': ['SEO', 'SEM', 'Google Analytics', '增长黑客', '用户增长', '社群运营', '内容运营', '活动策划'],
  '软技能': ['沟通能力', '团队协作', '领导力', '问题解决', '时间管理', '英语', '日语', '韩语', '德语', '法语'],
}

export const ALL_SKILLS: string[] = Object.values(SKILL_CATEGORIES).flat()

export function getSkillCategory(skill: string): string {
  for (const [category, skills] of Object.entries(SKILL_CATEGORIES)) {
    if (skills.some((s) => s.toLowerCase() === skill.toLowerCase())) {
      return category
    }
  }
  return '其他'
}
