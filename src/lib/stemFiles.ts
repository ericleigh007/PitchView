export const classifyGeneratedStemFile = (outputFile: string) => {
  const lowerName = outputFile.split(/[/\\]/).pop()?.toLowerCase() ?? outputFile.toLowerCase();

  if (lowerName.includes('_(other)_')) {
    return { id: 'other', label: 'Other stem' } as const;
  }

  if (lowerName.includes('_(vocals)_')) {
    return { id: 'vocals', label: 'Separated vocals' } as const;
  }

  if (lowerName.includes('karaoke') || lowerName.includes('instrumental') || lowerName.includes('accompaniment')) {
    return { id: 'other', label: 'Other stem' } as const;
  }

  if (lowerName.includes('other')) {
    return { id: 'other', label: 'Other stem' } as const;
  }

  if (lowerName.includes('vocals')) {
    return { id: 'vocals', label: 'Separated vocals' } as const;
  }

  return null;
};