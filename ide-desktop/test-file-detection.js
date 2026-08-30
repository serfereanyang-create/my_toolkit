// 简单测试文件检测功能
const { categorizeFile, getMediaType, getCategoryIcon, formatFileSize, validateFile, generateSmartPrompt } = require('./dist/lib/fileDetection.js');

console.log('测试文件分类：');
console.log('test.png ->', categorizeFile('test.png'));
console.log('document.pdf ->', categorizeFile('document.pdf'));
console.log('script.js ->', categorizeFile('script.js'));
console.log('data.csv ->', categorizeFile('data.csv'));
console.log('archive.zip ->', categorizeFile('archive.zip'));

console.log('\n测试媒体类型：');
console.log('test.png ->', getMediaType('test.png'));
console.log('test.jpg ->', getMediaType('test.jpg'));
console.log('doc.pdf ->', getMediaType('doc.pdf'));

console.log('\n测试图标：');
console.log('image ->', getCategoryIcon('image'));
console.log('document ->', getCategoryIcon('document'));
console.log('code ->', getCategoryIcon('code'));

console.log('\n测试文件大小格式化：');
console.log('500 ->', formatFileSize(500));
console.log('5000 ->', formatFileSize(5000));
console.log('5000000 ->', formatFileSize(5000000));

console.log('\n测试智能提示生成：');
const files1 = [{ name: 'test.png', category: 'image', size: 1000, path: '/test.png', icon: '🖼️' }];
console.log('单个图片 ->', generateSmartPrompt(files1));

const files2 = [
  { name: 'a.png', category: 'image', size: 1000, path: '/a.png', icon: '🖼️' },
  { name: 'b.jpg', category: 'image', size: 2000, path: '/b.jpg', icon: '🖼️' },
  { name: 'doc.pdf', category: 'document', size: 3000, path: '/doc.pdf', icon: '📄' }
];
console.log('多个文件 ->', generateSmartPrompt(files2));

console.log('\n✅ 文件检测模块测试完成');
